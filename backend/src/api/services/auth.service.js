// src/api/services/auth.service.js
const User = require("../../models/User.model");
const {
  AppError,
  BadRequestError,
  UnauthorizedError,
} = require("../../utils/errors");
const { generateToken } = require("../../utils/jwt"); // Impor fungsi generateToken
const { createOAuth2Client } = require("../../utils/googleOAuth2Client"); // Impor
const { google } = require("googleapis"); // Impor google untuk youtube API client nanti
const sendEmail = require("../../utils/emailSender"); // Impor pengirim email
const crypto = require("crypto"); // Modul bawaan Node.js untuk generate string acak
const config = require("../../config/environment");
const { OAuth2Client } = require("google-auth-library"); // Penting untuk verifikasi ID Token

const generateOtp = () => {
  // Generate 6 digit OTP
  return crypto.randomInt(100000, 999999).toString();
};

const registerUser = async (userData) => {
  const { username, email, password } = userData;

  let existingUser = await User.findOne({ email }); // Hanya cek email untuk OTP flow
  if (existingUser && existingUser.isVerified) {
    throw new BadRequestError(
      "Email sudah terdaftar dan terverifikasi. Silakan login."
    );
  }
  if (existingUser && !existingUser.isVerified) {
    // User sudah ada tapi belum verifikasi, kita bisa kirim ulang OTP atau minta mereka verifikasi
    // Untuk V1, kita akan update OTP dan kirim ulang.
    console.log(
      `Email ${email} sudah terdaftar tapi belum diverifikasi. Mengupdate OTP.`
    );
  }

  const otp = generateOtp();
  const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // OTP berlaku 10 menit

  let userToSave;
  if (existingUser && !existingUser.isVerified) {
    // User sudah ada, update OTP-nya
    existingUser.otpCode = otp;
    existingUser.otpExpiresAt = otpExpiresAt;
    // Password tidak diubah di sini kecuali ada logika khusus
    // Username juga tidak diubah
    userToSave = existingUser;
  } else {
    // User baru, buat entri baru
    // Cek username jika user baru (karena username unik)
    const existingUsername = await User.findOne({ username });
    if (existingUsername) {
      throw new BadRequestError(
        "Username sudah digunakan. Silakan pilih username lain."
      );
    }
    userToSave = new User({
      username,
      email,
      password, // Akan di-hash oleh pre-save hook
      otpCode: otp,
      otpExpiresAt,
      isVerified: false, // Defaultnya false
    });
  }

  try {
    await userToSave.save();

    // Kirim email OTP
    const emailOptions = {
      email: userToSave.email,
      subject: "Kode Verifikasi OTP Judi Guard Anda",
      text: `Halo ${userToSave.username},\n\nKode OTP Anda adalah: ${otp}\nKode ini berlaku selama 10 menit.\n\nJika Anda tidak meminta kode ini, abaikan email ini.\n\nTerima kasih,\nTim Judi Guard`,
      // html: `<p>...</p>` // Anda bisa membuat template HTML yang lebih bagus
    };

    const emailResult = await sendEmail(emailOptions);
    if (!emailResult.success) {
      console.error(
        "Gagal mengirim email OTP setelah registrasi:",
        emailResult.error
      );
      // Anda mungkin ingin menangani ini (misalnya, memberitahu user untuk coba lagi nanti)
      // Untuk sekarang, proses registrasi (penyimpanan user) tetap dianggap berhasil
      // tapi user tidak akan dapat OTP. Ini perlu perhatian lebih.
      // throw new AppError('User berhasil dibuat, tapi gagal mengirim OTP. Hubungi support.', 500);
    }
    if (emailResult.previewUrl) {
      console.log(
        `Email OTP dikirim (Ethereal). Preview: ${emailResult.previewUrl}`
      );
    }

    // Jangan kirim password atau OTP kembali ke client
    const userResponse = userToSave.toObject();
    delete userResponse.password;
    delete userResponse.otpCode;
    delete userResponse.otpExpiresAt;
    // JWT TIDAK DIBERIKAN DI SINI, user harus verifikasi OTP dulu

    return {
      message: `Registrasi berhasil. Kode OTP telah dikirim ke ${userToSave.email}. Silakan cek email Anda.`,
      user: userResponse, // Kirim data user dasar (tanpa token)
    };
  } catch (error) {
    // ... (penanganan error yang sudah ada, pastikan tidak ada JWT yang dikirim)
    if (error.name === "ValidationError") {
      /* ... */
    }
    if (error.code === 11000) {
      /* ... */
    }
    throw new AppError(`Gagal mendaftarkan pengguna: ${error.message}`, 500);
  }
};

// TAMBAHKAN FUNGSI INI
const loginUser = async (loginData) => {
  const { email, password } = loginData;

  // 1. Cari user berdasarkan email dan ambil passwordnya (karena select: false di model)
  const user = await User.findOne({ email }).select("+password");
  if (!user) {
    throw new UnauthorizedError("Email atau password salah.");
  }

  // 2. Bandingkan password yang diberikan dengan password di database
  // Pastikan method comparePassword sudah ada di User.model.js dan bekerja dengan benar
  const isPasswordMatch = await user.comparePassword(password);
  if (!isPasswordMatch) {
    throw new UnauthorizedError("Email atau password salah.");
  }

  // 3. Jika password cocok, buat JWT
  const payload = {
    userId: user._id,
    username: user.username,
    // Anda bisa menambahkan role atau data lain jika perlu
  };
  const token = generateToken(payload);

  // 4. Persiapkan data user untuk respons (tanpa password)
  const userResponse = user.toObject();
  delete userResponse.password;
  delete userResponse.youtubeAccessToken; // Sembunyikan token sensitif ini juga dari respons login umum
  delete userResponse.youtubeRefreshToken;
  delete userResponse.youtubeTokenExpiresAt;

  return { token, user: userResponse };
};
const signInWithGoogle = async (idTokenString) => {
  if (!config.googleSignIn || !config.googleSignIn.clientId) {
    console.error(
      "Konfigurasi Google Sign-In Client ID di backend belum lengkap."
    );
    throw new AppError(
      "Konfigurasi Google Sign-In Client ID di backend belum lengkap.",
      500
    );
  }
  const googleIdTokenVerifierClient = new OAuth2Client(
    config.googleSignIn.clientId
  );

  try {
    const ticket = await googleIdTokenVerifierClient.verifyIdToken({
      idToken: idTokenString,
      audience: config.googleSignIn.clientId,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.email || !payload.sub) {
      throw new UnauthorizedError(
        "Google ID Token tidak valid atau informasi tidak lengkap."
      );
    }

    if (!payload.email_verified) {
      console.warn(
        `Percobaan masuk dengan email Google yang belum terverifikasi: ${payload.email}`
      );
    }
    // ... (sisa logika signInWithGoogle seperti yang telah diperbaiki sebelumnya) ...
    // ... (mencari user, membuat user baru jika perlu, membuat token aplikasi) ...
    const googleId = payload.sub;
    const email = payload.email;
    const nameFromGoogle = payload.name || email.split("@")[0];
    const picture = payload.picture;

    let user = await User.findOne({
      $or: [{ googleId: googleId }, { email: email }],
    });
    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      let username = nameFromGoogle.replace(/\s+/g, "").toLowerCase();
      let count = 0;
      let tempUsername = username;
      while (await User.findOne({ username: tempUsername })) {
        count++;
        tempUsername = `${username}${count}`;
      }
      username = tempUsername;

      user = await User.create({
        googleId: googleId,
        email: email,
        username: username,
        isVerified: payload.email_verified || true,
        fullName: nameFromGoogle,
        profilePictureUrl: picture,
      });
    } else {
      if (!user.googleId) user.googleId = googleId;
      if (!user.isVerified && payload.email_verified) user.isVerified = true;
      user.fullName = nameFromGoogle;
      user.profilePictureUrl = picture;
      await user.save();
    }

    const appTokenPayload = { userId: user._id, username: user.username };
    const token = generateToken(appTokenPayload);

    const userResponse = user.toObject();
    delete userResponse.password;
    delete userResponse.googleId;

    return { token, user: userResponse, isNewUser };
  } catch (error) {
    console.error("Error saat sign in with Google (util):", error.message);
    if (
      error.message.includes("Token used too late") ||
      error.message.includes("Invalid token signature")
    ) {
      throw new UnauthorizedError(
        "Sesi Google tidak valid atau kedaluwarsa. Silakan coba lagi."
      );
    }
    if (error instanceof AppError || error instanceof UnauthorizedError)
      throw error;
    throw new AppError(
      `Gagal autentikasi dengan Google: ${error.message}`,
      500
    );
  }
};

const handleYoutubeOAuthCallback = async (authCode, judiGuardUserId) => {
  try {
    const oAuth2Client = createOAuth2Client();
    const { tokens } = await oAuth2Client.getToken(authCode); // Tukar code dengan tokens

    // Simpan tokens ke user
    // tokens berisi: access_token, refresh_token, expiry_date, scope, token_type
    // refresh_token hanya akan diberikan pada otorisasi pertama jika access_type: 'offline'

    const updateData = {
      youtubeAccessToken: tokens.access_token,
      // Simpan refresh_token hanya jika ada (Google hanya mengirimkannya sekali)
      ...(tokens.refresh_token && {
        youtubeRefreshToken: tokens.refresh_token,
      }),
      youtubeTokenExpiresAt: new Date(tokens.expiry_date),
    };

    // Opsional: Dapatkan info channel pengguna setelah mendapatkan token
    // Ini untuk menyimpan youtubeChannelId dan youtubeChannelName
    oAuth2Client.setCredentials(tokens);
    const youtube = google.youtube({ version: "v3", auth: oAuth2Client });
    try {
      const channelInfoResponse = await youtube.channels.list({
        mine: true, // Mendapatkan channel milik pengguna yang terautentikasi
        part: "id,snippet", // id dan snippet (untuk nama channel)
      });

      if (
        channelInfoResponse.data.items &&
        channelInfoResponse.data.items.length > 0
      ) {
        const channel = channelInfoResponse.data.items[0];
        updateData.youtubeChannelId = channel.id;
        updateData.youtubeChannelName = channel.snippet.title;
      }
    } catch (channelError) {
      console.error(
        "Gagal mendapatkan info channel YouTube setelah OAuth:",
        channelError.message
      );
      // Lanjutkan meskipun gagal mendapatkan info channel, token tetap disimpan
    }

    const updatedUser = await User.findByIdAndUpdate(
      judiGuardUserId,
      updateData,
      { new: true } // Kembalikan dokumen yang sudah diupdate
    ).select("-password"); // Jangan kembalikan password

    if (!updatedUser) {
      throw new AppError(
        "User Judi Guard tidak ditemukan untuk menyimpan token YouTube.",
        404
      );
    }

    // Jangan kembalikan token sensitif dalam respons ini
    const userResponse = updatedUser.toObject();
    delete userResponse.youtubeAccessToken;
    delete userResponse.youtubeRefreshToken;
    delete userResponse.youtubeTokenExpiresAt;

    return { message: "Akun YouTube berhasil terhubung!", user: userResponse };
  } catch (error) {
    console.error("Error selama callback YouTube OAuth:", error.message);
    // Error bisa dari oAuth2Client.getToken() atau saat update user
    // Periksa apakah error dari Google API atau dari aplikasi kita
    if (
      error.response &&
      error.response.data &&
      error.response.data.error_description
    ) {
      // Error dari Google
      throw new AppError(
        `Error dari Google: ${error.response.data.error_description}`,
        500
      );
    }
    throw new AppError(
      `Gagal menghubungkan akun YouTube: ${error.message}`,
      500
    );
  }
};

const verifyOtp = async (email, otpCode) => {
  if (!email || !otpCode) {
    throw new BadRequestError("Email dan kode OTP diperlukan.");
  }

  const user = await User.findOne({ email }).select("+otpCode +otpExpiresAt"); // Ambil field OTP
  if (!user) {
    throw new NotFoundError("Pengguna tidak ditemukan.");
  }
  if (user.isVerified) {
    throw new BadRequestError("Akun ini sudah diverifikasi sebelumnya.");
  }
  if (!user.otpCode || !user.otpExpiresAt) {
    throw new BadRequestError(
      "Tidak ada OTP yang tertunda untuk akun ini. Silakan daftar atau minta OTP baru."
    );
  }
  if (user.otpCode !== otpCode) {
    throw new BadRequestError("Kode OTP salah.");
  }
  if (new Date() > user.otpExpiresAt) {
    // OTP sudah kedaluwarsa, bersihkan
    user.otpCode = undefined;
    user.otpExpiresAt = undefined;
    await user.save();
    throw new BadRequestError(
      "Kode OTP sudah kedaluwarsa. Silakan minta OTP baru."
    );
  }

  // OTP valid
  user.isVerified = true;
  user.otpCode = undefined; // Hapus OTP setelah digunakan
  user.otpExpiresAt = undefined;
  await user.save();

  // Generate JWT Judi Guard untuk user
  const judiGuardTokenPayload = { userId: user._id, username: user.username };
  const token = generateToken(judiGuardTokenPayload);

  const userResponse = user.toObject();
  delete userResponse.password;
  // Hapus field OTP yang sudah tidak relevan
  delete userResponse.otpCode;
  delete userResponse.otpExpiresAt;

  return {
    message: "Verifikasi OTP berhasil! Anda sekarang login.",
    token,
    user: userResponse,
  };
};

const resendOtp = async (email) => {
  if (!email) {
    throw new BadRequestError("Email diperlukan untuk mengirim ulang OTP.");
  }

  const user = await User.findOne({ email });
  if (!user) {
    throw new NotFoundError("Pengguna dengan email ini tidak ditemukan.");
  }
  if (user.isVerified) {
    throw new BadRequestError("Akun ini sudah diverifikasi.");
  }

  const otp = generateOtp();
  const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // OTP baru berlaku 10 menit

  user.otpCode = otp;
  user.otpExpiresAt = otpExpiresAt;
  await user.save();

  // Kirim email OTP
  const emailOptions = {
    email: user.email,
    subject: "Kode Verifikasi OTP Judi Guard Anda (Kirim Ulang)",
    text: `Halo ${user.username},\n\nKode OTP baru Anda adalah: ${otp}\nKode ini berlaku selama 10 menit.\n\nTerima kasih,\nTim Judi Guard`,
  };

  const emailResult = await sendEmail(emailOptions);
  if (!emailResult.success) {
    console.error("Gagal mengirim ulang email OTP:", emailResult.error);
    // throw new AppError('Gagal mengirim ulang OTP. Hubungi support.', 500);
  }
  if (emailResult.previewUrl) {
    console.log(
      `Email OTP (kirim ulang) dikirim. Preview: ${emailResult.previewUrl}`
    );
  }

  return { message: `Kode OTP baru telah dikirim ke ${user.email}.` };
};

module.exports = {
  registerUser,
  loginUser,
  handleYoutubeOAuthCallback,
  verifyOtp,
  resendOtp,
  signInWithGoogle,
};
