import { getDriveClient, getOrCreateStremioFolder } from '../addon/moch/gdrive.js';

console.log('Testing Service Account connection...');
const { drive } = getDriveClient();

async function testSA() {
  try {
    const res = await drive.files.list({
      pageSize: 10,
      fields: 'files(id, name, mimeType)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });

    console.log('✅ Service Account Bağlantısı Başarılı!');
    console.log(`Görünen Dosya Sayısı: ${res.data.files?.length || 0}`);
    if (res.data.files?.length) {
      res.data.files.forEach(f => console.log(` - ${f.name} (${f.mimeType}) [${f.id}]`));
    }

    const folderId = await getOrCreateStremioFolder(drive);
    console.log(`📁 /Stremio Klasör Kimliği: ${folderId}`);
    console.log('🎉 Hizmet Hesabı (Service Account) Ömür Boyu Kalıcı Olarak Devrede!');
  } catch (err) {
    console.error('❌ Hata:', err?.message || err);
  }
}

testSA();
