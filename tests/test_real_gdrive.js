
import { getDriveClient, getOrCreateStremioFolder } from '../addon/moch/gdrive.js';

console.log('Connecting to Google Drive with Refresh Token...');
const { drive } = getDriveClient();

async function testConnection() {
  try {
    // 1. Get user quota
    const about = await drive.about.get({ fields: 'user, storageQuota' });
    const user = about.data.user;
    const quota = about.data.storageQuota;

    console.log(`✅ Bağlantı Başarılı!`);
    console.log(`👤 Kullanıcı: ${user.displayName} (${user.emailAddress})`);
    console.log(`💾 Toplam Alan: ${(quota.limit / (1024 ** 4)).toFixed(2)} TB`);
    console.log(`📦 Kullanılan: ${(quota.usage / (1024 ** 3)).toFixed(2)} GB`);

    // 2. Test Stremio folder creation / retrieval
    const folderId = await getOrCreateStremioFolder(drive);
    console.log(`📁 /Stremio Klasör Kimliği: ${folderId}`);
    console.log('🎉 Google Drive Debrid Altyapısı 100% Çalışır Durumda!');
  } catch (err) {
    console.error('❌ Bağlantı hatası:', err?.message || err);
    process.exit(1);
  }
}

testConnection();
