// src/api/services/videoAnalysis.service.js
const User = require("../models/User.model");
const VideoAnalysis = require("../models/VideoAnalysis.model");
const AnalyzedComment = require("../models/AnalyzedComment.model");
const youtubeService = require("./youtube.service");
const { getYouTubeVideoId } = require("../../utils/youtubeHelper");
const {
  AppError,
  BadRequestError,
  NotFoundError,
  ForbiddenError,
} = require("../../utils/errors"); // <-- TAMBAHKAN ForbiddenError DI SINI
const config = require("../../config/environment");
const { processAndSaveSingleComment } = require("../../utils/commentProcessor");
const aiService = require("./ai.service");
const mongoose = require("mongoose");

/**
 * Memulai proses analisis HANYA untuk komentar tingkat atas (top-level comments)
 * dengan alur kerja yang dioptimalkan untuk performa.
 */
const startVideoAnalysis = async (userId, youtubeVideoUrl) => {
  // --- BAGIAN 1: SETUP DAN VALIDASI (Tidak berubah) ---
  const youtubeVideoId = getYouTubeVideoId(youtubeVideoUrl);
  if (!youtubeVideoId) {
    throw new BadRequestError("URL Video YouTube tidak valid.");
  }

  const youtubeClient = await youtubeService.getAuthenticatedYouTubeClient(
    userId
  );

  // Buat entri log analisis di database
  // <<< PENYEMPURNAAN: Inisialisasi totalCommentsAnalyzed dari awal >>>
  let analysisEntry = await VideoAnalysis.create({
    userId,
    youtubeVideoId,
    status: "PROCESSING",
    processingStartedAt: Date.now(),
    totalCommentsAnalyzed: 0,
  });

  try {
    const videoDetails = await youtubeService.getVideoDetails(youtubeVideoId, {
      youtubeClient,
    });
    if (videoDetails?.snippet) {
      analysisEntry.videoTitle = videoDetails.snippet.title;
    }

    // --- BAGIAN 2: AMBIL DATA KOMENTAR (Tidak berubah) ---
    const commentThreads = await youtubeService.fetchCommentsForVideo(
      youtubeVideoId,
      userId,
      { youtubeClient },
      100,
      config.MAX_TOP_LEVEL_COMMENTS || 200
    );

    analysisEntry.totalCommentsFetched = commentThreads.length;

    if (commentThreads.length === 0) {
      console.log(
        `[VideoAnalysis-${analysisEntry._id}] Tidak ada komentar ditemukan. Analisis selesai.`
      );
      analysisEntry.status = "COMPLETED";
      analysisEntry.completedAt = Date.now();
      await analysisEntry.save();
      return analysisEntry.toObject();
    }

    // --- BAGIAN 3: PROSES DENGAN AI (Dengan Optimasi) ---
    const validComments = commentThreads
      .map((thread) => {
        const comment = thread?.snippet?.topLevelComment;
        // Validasi ketat struktur komentar
        if (
          !comment?.id ||
          !comment.snippet ||
          !comment.snippet.authorChannelId?.value
        ) {
          console.warn("Struktur komentar tidak valid:", comment);
          return null;
        }
        return comment;
      })
      .filter(Boolean); // Hapus null/undefined

    const commentIdsFromYouTube = validComments.map((c) => {
      if (!c.id.startsWith("Ug")) {
        throw new Error(`Format YouTube Comment ID tidak valid: ${c.id}`);
      }
      return c.id;
    });
    const existingCommentIds = new Set(
      (
        await AnalyzedComment.find({
          youtubeCommentId: { $in: commentIdsFromYouTube },
        }).select("youtubeCommentId -_id")
      ).map((c) => c.youtubeCommentId)
    );
    const newCommentsToAnalyze = validComments.filter(
      (c) => !existingCommentIds.has(c.id)
    );

    if (newCommentsToAnalyze.length > 0) {
      console.log(
        `Memulai analisis untuk ${newCommentsToAnalyze.length} komentar baru`
      );

      const analysisPromises = newCommentsToAnalyze.map((comment) =>
        aiService.analyzeTextWithAI(comment.snippet.textOriginal)
      );
      const aiResults = await Promise.all(analysisPromises);

      const saveOperations = [];

      for (let i = 0; i < newCommentsToAnalyze.length; i++) {
        const comment = newCommentsToAnalyze[i];
        const aiResult = aiResults[i];

        // Pastikan semua field penting ada
        if (!comment.snippet.authorChannelId?.value) {
          console.error("Komentar tidak memiliki authorChannelId:", comment.id);
          continue;
        }

        const documentToSave = {
          analysisId: analysisEntry._id, // Tidak perlu new mongoose.Types.ObjectId
          userId: new mongoose.Types.ObjectId(userId),
          youtubeVideoId,
          youtubeCommentId: comment.id,
          authorChannelId: comment.snippet.authorChannelId.value, // << PENAMBAHAN PENTING
          parentYoutubeCommentId: null,
          commentTextOriginal: comment.snippet.textOriginal,
          commentTextDisplay: comment.snippet.textDisplay,
          commentAuthorDisplayName: comment.snippet.authorDisplayName,
          commentAuthorProfileImageUrl: comment.snippet.authorProfileImageUrl,
          commentPublishedAt: new Date(comment.snippet.publishedAt),
          commentUpdatedAt: new Date(comment.snippet.updatedAt),
          likeCount: comment.snippet.likeCount || 0,
          classification: aiResult.classification,
          aiConfidenceScore: aiResult.confidenceScore,
          aiModelVersion: aiResult.modelVersion,
          metadata: {
            // Simpan data tambahan
            isReply: false,
            originalResponse: comment, // Simpan raw data untuk referensi
          },
        };

        saveOperations.push(
          AnalyzedComment.create(documentToSave)
            .then(() => 1)
            .catch((error) => {
              console.error(
                `Gagal menyimpan komentar ${comment.id}:`,
                error.message
              );
              return 0;
            })
        );
      }

      const results = await Promise.all(saveOperations);
      const successfulSaves = results.reduce((sum, val) => sum + val, 0);

      console.log(
        `Berhasil menyimpan ${successfulSaves}/${newCommentsToAnalyze.length} komentar`
      );
      analysisEntry.totalCommentsAnalyzed = successfulSaves;
    }

    // --- BAGIAN 4: FINALISASI ---
    analysisEntry.status = "COMPLETED";
    analysisEntry.completedAt = Date.now();

    // <<< PENYEMPURNAAN: Hanya satu kali 'save' di akhir blok try >>>
    await analysisEntry.save();

    console.log(
      `[VideoAnalysis-${analysisEntry._id}] Analisis selesai. Komentar baru yang dianalisis: ${analysisEntry.totalCommentsAnalyzed}.`
    );

    return analysisEntry.toObject(); // Kembalikan POJO agar konsisten
  } catch (error) {
    // --- Error Handling ---
    // <<< PENYEMPURNAAN: Log seluruh objek error untuk stack trace >>>
    console.error(
      `[VideoAnalysis-${analysisEntry?._id}] Terjadi error besar selama proses:`,
      error
    );

    if (analysisEntry) {
      // Pastikan analysisEntry ada sebelum mencoba save
      analysisEntry.status = "FAILED";
      analysisEntry.errorMessage = error.message;
      await analysisEntry.save();
    }

    throw error;
  }
};

/**
 * Mengambil semua komentar dan balasan yang telah dianalisis untuk sebuah VideoAnalysis.
 * @param {string} videoAnalysisId - ID dari VideoAnalysis.
 * @param {string} userId - ID User Judi Guard yang memiliki analisis tersebut.
 * @returns {Promise<Array<object>>} Array objek AnalyzedComment (POJO), diurutkan berdasarkan tanggal publikasi.
 */
const getAnalysisResults = async (videoAnalysisId, userId) => {
  const videoAnalysis = await VideoAnalysis.findOne({
    _id: videoAnalysisId,
    userId: userId,
  });

  if (!videoAnalysis) {
    throw new NotFoundError(
      "Data analisis video tidak ditemukan atau Anda tidak memiliki akses."
    );
  }

  // Mengambil semua komentar dan balasan yang terkait dengan videoAnalysisId ini
  const analyzedComments = await AnalyzedComment.find({
    analysisId: videoAnalysisId, // Pastikan field ini sesuai dengan yang disimpan
  }).sort({ commentPublishedAt: 1 }); // Tambahkan pengurutan

  return analyzedComments;
};

/**
 * Memulai proses penghapusan semua komentar yang diklasifikasikan sebagai "judi"
 * untuk sebuah VideoAnalysis tertentu secara paralel.
 * @param {string} userId - ID User Judi Guard yang meminta.
 * @param {string} analysisId - ID dari VideoAnalysis.
 * @returns {Promise<object>} Objek yang berisi ringkasan hasil operasi.
 */
const requestBatchDeleteJudiComments = async (userId, analysisId) => {
  // 1. Verifikasi bahwa VideoAnalysis ada dan milik user yang meminta
  const videoAnalysis = await VideoAnalysis.findOne({
    _id: AnalysisId,
    userId: userId,
  });

  if (!videoAnalysis) {
    throw new NotFoundError(
      "Data analisis video tidak ditemukan atau Anda tidak memiliki akses."
    );
  }

  // 2. Dapatkan YouTube client yang terautentikasi (hanya sekali di awal)
  let youtubeClient;
  try {
    youtubeClient = await youtubeService.getAuthenticatedYouTubeClient(userId);
  } catch (authError) {
    console.error(
      `[VideoAnalysis-${videoAnalysisId}] Error autentikasi YouTube untuk batch delete:`,
      authError.message
    );
    throw authError; // Teruskan error autentikasi
  }

  // 3. Ambil semua komentar yang akan dihapus
  const classificationForJudi = "JUDI"; // Definisikan sebagai konstanta
  const commentsToBatchDelete = await AnalyzedComment.find({
    videoAnalysisId: videoAnalysisId,
    classification: classificationForJudi,
    isDeletedOnYoutube: { $ne: true }, // Hanya yang belum ditandai terhapus
  });

  // Jika tidak ada komentar yang perlu dihapus, langsung selesaikan
  if (commentsToBatchDelete.length === 0) {
    return {
      message: `Tidak ada komentar baru berkategori '${classificationForJudi}' yang perlu dihapus.`,
      totalTargeted: 0,
      successfullyDeleted: 0,
      failedToDelete: 0,
      failures: [],
    };
  }

  console.log(
    `[VideoAnalysis-${videoAnalysisId}] Memulai batch delete untuk ${commentsToBatchDelete.length} komentar '${classificationForJudi}'. User ID: ${userId}`
  );

  // Update status VideoAnalysis untuk menandakan proses sedang berjalan
  videoAnalysis.status = "DELETING_CLASSIFIED_COMMENTS";
  videoAnalysis.lastBatchDeletionAttemptAt = Date.now();
  await videoAnalysis.save();

  // 4. Buat array dari semua promise penghapusan
  const deletionPromises = commentsToBatchDelete.map(async (comment) => {
    try {
      // Tandai usaha penghapusan
      comment.deletionAttemptedAt = Date.now();

      // Panggil service untuk menghapus dari YouTube
      await youtubeService.deleteYoutubeComment(comment.youtubeCommentId, {
        youtubeClient,
      });

      // Jika berhasil, update status di DB kita
      comment.isDeletedOnYoutube = true;
      comment.deletionError = null;
      await comment.save();

      // Kembalikan objek sukses untuk Promise.allSettled
      return { commentId: comment.youtubeCommentId };
    } catch (error) {
      // Jika youtubeService.deleteYoutubeComment melempar error
      const errorMessage = error.message || "Unknown error during deletion";
      console.error(
        `[VideoAnalysisService] Gagal menghapus komentar ${comment.youtubeCommentId} dari YouTube:`,
        errorMessage
      );

      // Update status di DB kita bahwa terjadi error
      comment.isDeletedOnYoutube = false;
      comment.deletionError = errorMessage;
      await comment.save();

      // Lempar error yang berisi info berguna agar ditangkap oleh Promise.allSettled
      // Ini akan membuat status promise menjadi 'rejected'
      throw {
        commentId: comment.youtubeCommentId,
        reason: errorMessage,
      };
    }
  });

  // 5. Tunggu SEMUA promise penghapusan selesai, baik yang sukses maupun gagal
  const results = await Promise.allSettled(deletionPromises);

  // 6. Hitung hasil berdasarkan array results
  let successfullyDeletedCount = 0;
  let failedToDeleteCount = 0;
  const deletionFailures = [];

  results.forEach((result) => {
    if (result.status === "fulfilled") {
      successfullyDeletedCount++;
    } else {
      // status === 'rejected'
      failedToDeleteCount++;
      // result.reason adalah objek error yang kita lempar dari blok catch di atas
      deletionFailures.push({
        youtubeCommentId: result.reason.commentId,
        error: result.reason.reason,
      });
    }
  });

  // 7. Update status akhir pada VideoAnalysis
  if (failedToDeleteCount > 0 && successfullyDeletedCount > 0) {
    videoAnalysis.status = "COMPLETED_DELETION_WITH_PARTIAL_ERRORS";
  } else if (failedToDeleteCount > 0 && successfullyDeletedCount === 0) {
    videoAnalysis.status = "FAILED_ALL_DELETIONS";
  } else if (failedToDeleteCount === 0 && successfullyDeletedCount > 0) {
    videoAnalysis.status = "COMPLETED_ALL_DELETIONS_SUCCESSFULLY";
  } else {
    // Jika tidak ada yang diproses (tidak seharusnya terjadi jika length > 0)
    videoAnalysis.status = "COMPLETED"; // Kembali ke status umum
  }

  // Simpan statistik penghapusan ke dokumen analisis utama
  videoAnalysis.lastBatchDeletionSuccessCount = successfullyDeletedCount;
  videoAnalysis.lastBatchDeletionFailureCount = failedToDeleteCount;
  videoAnalysis.completedAt = Date.now(); // Atau gunakan field `lastBatchDeletionCompletedAt`
  await videoAnalysis.save();

  console.log(
    `[VideoAnalysis-${videoAnalysisId}] Batch delete selesai. Berhasil: ${successfullyDeletedCount}, Gagal: ${failedToDeleteCount}.`
  );

  // 8. Kembalikan ringkasan hasil ke controller
  return {
    message: `Proses penghapusan komentar '${classificationForJudi}' selesai.`,
    totalTargeted: commentsToBatchDelete.length,
    successfullyDeleted: successfullyDeletedCount,
    failedToDelete: failedToDeleteCount,
    failures: deletionFailures,
  };
};

// const requestDeleteYoutubeComment = async (
//   userId,
//   analyzedCommentId,
//   youtubeCommentId
// ) => {
//   // Validate IDs
//   if (!mongoose.Types.ObjectId.isValid(analyzedCommentId)) {
//     throw new BadRequestError("Invalid analyzed comment ID");
//   }

//   if (!youtubeCommentId?.startsWith("Ug")) {
//     throw new BadRequestError("Invalid YouTube comment ID format");
//   }

//   // Find and validate comment
//   const comment = await AnalyzedComment.findOne({
//     _id: analyzedCommentId,
//     userId,
//     youtubeCommentId,
//   });

//   if (!comment) {
//     throw new NotFoundError("Comment not found or not owned by user");
//   }

//   if (comment.isDeletedOnYoutube) {
//     return comment.toObject();
//   }

//   try {
//     const youtubeClient = await youtubeService.getAuthenticatedYouTubeClient(
//       userId
//     );
//     await youtubeService.deleteYoutubeComment(youtubeCommentId, {
//       youtubeClient,
//     });

//     // Update comment status
//     const updatedComment = await AnalyzedComment.findByIdAndUpdate(
//       analyzedCommentId,
//       {
//         isDeletedOnYoutube: true,
//         deletionAttemptedAt: new Date(),
//         deletionError: null,
//       },
//       { new: true }
//     );

//     return updatedComment.toObject();
//   } catch (error) {
//     // Update with error status
//     await AnalyzedComment.findByIdAndUpdate(analyzedCommentId, {
//       isDeletedOnYoutube: false,
//       deletionAttemptedAt: new Date(),
//       deletionError: error.message,
//     });

//     // Re-throw with proper mapping
//     if (error.code === 400) {
//       throw new BadRequestError(error.message);
//     }
//     if (error.code === 403 && error.message.includes("NOT_COMMENT_OWNER")) {
//       console.error("Tidak bisa menghapus komentar orang lain!");
//       // Beri opsi alternatif (misal: laporkan komentar)
//       await youtubeService.reportComment(youtubeCommentId, "SPAM");
//     }
//     throw error;
//   } finally {
//     next(error);
//   }
// };

/**
 * Meminta penghapusan atau moderasi komentar YouTube berdasarkan kepemilikan.
 * @param {string} userId ID pengguna dari database lokal Anda.
 * @param {string} analyzedCommentId ID komentar dari database AnalysedComment Anda.
 * @param {string} youtubeCommentId ID komentar YouTube yang sebenarnya.
 * @returns {object} Objek komentar yang diperbarui dari database Anda.
 * @throws {Error} Error jika validasi gagal, komentar tidak ditemukan, atau ada masalah API.
 */
const requestDeleteYoutubeComment = async (
  userId,
  analyzedCommentId,
  youtubeCommentId
) => {
  // 1. Validasi ID
  if (!mongoose.Types.ObjectId.isValid(analyzedCommentId)) {
    throw new BadRequestError("Invalid analyzed comment ID");
  }

  // YouTube comment IDs selalu dimulai dengan 'Ug'
  if (!youtubeCommentId?.startsWith("Ug")) {
    throw new BadRequestError("Invalid YouTube comment ID format");
  }

  // 2. Cari dan validasi komentar dari database Anda
  const comment = await AnalyzedComment.findOne({
    _id: analyzedCommentId,
    userId,
    youtubeCommentId,
  });

  if (!comment) {
    throw new NotFoundError(
      "Comment not found or not owned by user in database"
    );
  }

  // 3. Jika sudah ditandai sebagai terhapus/dimoderasi di database, kembalikan saja
  // Anda mungkin ingin mengganti 'isDeletedOnYoutube' dengan 'isRemovedFromYoutube'
  // atau menambahkan 'isModeratedOnYoutube' untuk kejelasan.
  if (comment.isDeletedOnYoutube || comment.isModeratedOnYoutube) {
    // Asumsi ada isModeratedOnYoutube
    console.log(
      `[VIDEO_ANALYSIS_SERVICE] Komentar ${youtubeCommentId} sudah ditandai dihapus/dimoderasi.`
    );
    return comment.toObject();
  }

  const youtubeClient = await youtubeService.getAuthenticatedYouTubeClient(
    userId
  );

  let updatedComment;
  try {
    // 4. Dapatkan detail komentar dari YouTube untuk memeriksa kepemilikan secara real-time
    const youtubeCommentDetailsRes = await youtubeClient.comments
      .list({
        id: youtubeCommentId,
        part: "snippet",
      })
      .execute();

    if (youtubeCommentDetailsRes.data.items.length === 0) {
      throw new NotFoundError("Komentar tidak ditemukan di YouTube.");
    }
    const actualYoutubeComment = youtubeCommentDetailsRes.data.items[0];
    const commentAuthorChannelId =
      actualYoutubeComment.snippet.authorChannelId?.value;

    const myChannelRes = await youtubeClient.channels
      .list({
        mine: true,
        part: "id",
      })
      .execute();
    const authenticatedUserChannelId = myChannelRes.data.items[0]?.id;

    // 5. Tentukan apakah komentar dapat dihapus permanen atau hanya dimoderasi
    if (commentAuthorChannelId === authenticatedUserChannelId) {
      // Jika komentar dibuat oleh channel pengguna yang diautentikasi
      console.log(
        `[VIDEO_ANALYSIS_SERVICE] Komentar milik pengguna, mencoba penghapusan permanen: ${youtubeCommentId}`
      );
      await youtubeService.deleteYoutubeComment(youtubeCommentId, {
        youtubeClient,
      });
      // Perbarui status database: berhasil dihapus permanen
      updatedComment = await AnalyzedComment.findByIdAndUpdate(
        analyzedCommentId,
        {
          isDeletedOnYoutube: true,
          isModeratedOnYoutube: false, // Jika dihapus permanen, tidak dimoderasi
          deletionAttemptedAt: new Date(),
          deletionError: null,
        },
        { new: true }
      );
    } else {
      // Jika komentar bukan milik pengguna yang diautentikasi, lakukan moderasi (sembunyikan sebagai spam)
      console.log(
        `[VIDEO_ANALYSIS_SERVICE] Komentar bukan milik pengguna, mencoba moderasi (likelySpam): ${youtubeCommentId}`
      );
      await youtubeService.moderateYoutubeComment(
        youtubeCommentId,
        "likelySpam",
        {
          youtubeClient,
        }
      );
      // Perbarui status database: berhasil dimoderasi/disembunyikan
      updatedComment = await AnalyzedComment.findByIdAndUpdate(
        analyzedCommentId,
        {
          isDeletedOnYoutube: false, // Tidak dihapus permanen
          isModeratedOnYoutube: true, // Berhasil disembunyikan via moderasi
          deletionAttemptedAt: new Date(),
          deletionError: null,
        },
        { new: true }
      );
    }

    return updatedComment.toObject();
  } catch (error) {
    console.error(
      `[VIDEO_ANALYSIS_SERVICE] Error saat memproses komentar ${youtubeCommentId}:`,
      error
    );

    // Perbarui database dengan status error
    await AnalyzedComment.findByIdAndUpdate(analyzedCommentId, {
      isDeletedOnYoutube: false,
      isModeratedOnYoutube: false, // Reset status jika ada error
      deletionAttemptedAt: new Date(),
      deletionError: error.message,
    });

    // Lempar kembali error dengan mapping yang sesuai
    if (error.code === 400 || error instanceof BadRequestError) {
      throw new BadRequestError(error.message, error.details);
    }
    if (error.code === 404 || error instanceof NotFoundError) {
      throw new NotFoundError(error.message, error.details);
    }
    if (error.code === 403) {
      // Penanganan spesifik untuk kasus tidak bisa menghapus permanen
      if (
        error.message.includes("NOT_COMMENT_OWNER_CANNOT_DELETE_PERMANENtLY")
      ) {
        throw new ForbiddenError(
          "Komentar ini bukan milik Anda. Komentar akan disembunyikan sebagai spam di video Anda, bukan dihapus permanen. Silakan periksa panel moderasi YouTube Anda.",
          error.details
        );
      }
      if (error.message.includes("NOT_CHANNEL_OWNER_OF_VIDEO_FOR_MODERATION")) {
        throw new ForbiddenError(
          "Anda tidak memiliki izin untuk memoderasi komentar di video ini. Pastikan Anda adalah pemilik video.",
          error.details
        );
      }
      throw new ForbiddenError(error.message, error.details);
    }
    throw error; // Lempar error lainnya
  }
  // Hapus baris `finally { next(error); }`
};

module.exports = {
  startVideoAnalysis,
  getAnalysisResults,
  requestBatchDeleteJudiComments,
  requestDeleteYoutubeComment,
};
