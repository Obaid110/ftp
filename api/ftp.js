const ftp = require('basic-ftp');
const SftpClient = require('ssh2-sftp-client');
const archiver = require('archiver');
const { PassThrough } = require('stream');

// Helper: Connect to FTP/FTPS
async function connectFTP({ host, port, user, password, secure }) {
  const client = new ftp.Client();
  client.ftp.verbose = false;
  await client.access({
    host,
    port: Number(port) || 21,
    user,
    password,
    secure: secure === true || secure === 'true'
  });
  return client;
}

// Helper: Connect to SFTP
async function connectSFTP({ host, port, user, password }) {
  const sftp = new SftpClient();
  await sftp.connect({
    host,
    port: Number(port) || 22,
    username: user,
    password
  });
  return sftp;
}

// Recursive folder scanner for FTP
async function scanFtpRecursive(client, dirPath, fileList = []) {
  const list = await client.list(dirPath);
  for (const item of list) {
    if (item.name === '.' || item.name === '..') continue;
    const fullPath = dirPath === '/' ? `/${item.name}` : `${dirPath}/${item.name}`;
    if (item.isDirectory) {
      await scanFtpRecursive(client, fullPath, fileList);
    } else {
      fileList.push({ name: item.name, path: fullPath, size: item.size || 0 });
    }
  }
  return fileList;
}

// Recursive folder scanner for SFTP
async function scanSftpRecursive(sftp, dirPath, fileList = []) {
  const list = await sftp.list(dirPath);
  for (const item of list) {
    if (item.name === '.' || item.name === '..') continue;
    const fullPath = dirPath === '/' ? `/${item.name}` : `${dirPath}/${item.name}`;
    if (item.type === 'd') {
      await scanSftpRecursive(sftp, fullPath, fileList);
    } else {
      fileList.push({ name: item.name, path: fullPath, size: item.size || 0 });
    }
  }
  return fileList;
}

module.exports = async function handler(req, res) {
  // Enable CORS for frontend access
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Only POST requests allowed' });
  }

  const {
    action = 'list',
    protocol = 'ftp',
    host,
    port,
    user,
    password,
    path: targetPath = '/',
    files = [] // Used for batch zip download
  } = req.body || {};

  if (!host || !user) {
    return res.status(400).json({ success: false, error: 'Host and username are required' });
  }

  let ftpClient = null;
  let sftpClient = null;

  try {
    // ==========================================
    // 1. LIST FILES IN A DIRECTORY
    // ==========================================
    if (action === 'list') {
      if (protocol === 'sftp') {
        sftpClient = await connectSFTP({ host, port, user, password });
        const rawList = await sftpClient.list(targetPath);
        const items = rawList
          .filter(i => i.name !== '.' && i.name !== '..')
          .map(i => ({
            name: i.name,
            type: i.type === 'd' ? 'folder' : 'file',
            size: i.size || 0,
            modifiedAt: i.modifyTime ? new Date(i.modifyTime).toISOString() : null,
            path: targetPath === '/' ? `/${i.name}` : `${targetPath}/${i.name}`
          }));
        await sftpClient.end();
        return res.status(200).json({ success: true, path: targetPath, items });
      } else {
        ftpClient = await connectFTP({ host, port, user, password, secure: protocol === 'ftps' });
        const rawList = await ftpClient.list(targetPath);
        const items = rawList
          .filter(i => i.name !== '.' && i.name !== '..')
          .map(i => ({
            name: i.name,
            type: i.isDirectory ? 'folder' : 'file',
            size: i.size || 0,
            modifiedAt: i.rawModifiedAt || null,
            path: targetPath === '/' ? `/${i.name}` : `${targetPath}/${i.name}`
          }));
        ftpClient.close();
        return res.status(200).json({ success: true, path: targetPath, items });
      }
    }

    // ==========================================
    // 2. SCAN ALL FILES RECURSIVELY
    // ==========================================
    if (action === 'scan') {
      let allFiles = [];
      if (protocol === 'sftp') {
        sftpClient = await connectSFTP({ host, port, user, password });
        allFiles = await scanSftpRecursive(sftpClient, targetPath);
        await sftpClient.end();
      } else {
        ftpClient = await connectFTP({ host, port, user, password, secure: protocol === 'ftps' });
        allFiles = await scanFtpRecursive(ftpClient, targetPath);
        ftpClient.close();
      }
      return res.status(200).json({ success: true, total: allFiles.length, files: allFiles });
    }

    // ==========================================
    // 3. DOWNLOAD SINGLE FILE
    // ==========================================
    if (action === 'download') {
      const fileName = targetPath.split('/').pop() || 'download.bin';
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
      res.setHeader('Content-Type', 'application/octet-stream');

      if (protocol === 'sftp') {
        sftpClient = await connectSFTP({ host, port, user, password });
        const buffer = await sftpClient.get(targetPath);
        await sftpClient.end();
        return res.status(200).send(buffer);
      } else {
        ftpClient = await connectFTP({ host, port, user, password, secure: protocol === 'ftps' });
        const pass = new PassThrough();
        const chunks = [];
        pass.on('data', chunk => chunks.push(chunk));
        await ftpClient.downloadTo(pass, targetPath);
        ftpClient.close();
        return res.status(200).send(Buffer.concat(chunks));
      }
    }

    // ==========================================
    // 4. DOWNLOAD ALL (OR BATCH) AS ZIP
    // ==========================================
    if (action === 'zip') {
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="ftp_all_files.zip"');

      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.pipe(res);

      if (protocol === 'sftp') {
        sftpClient = await connectSFTP({ host, port, user, password });
        const targetFiles = files.length > 0 ? files : await scanSftpRecursive(sftpClient, targetPath);
        for (const f of targetFiles) {
          const buf = await sftpClient.get(f.path);
          archive.append(buf, { name: f.path.replace(/^\/+/, '') });
        }
        await archive.finalize();
        await sftpClient.end();
      } else {
        ftpClient = await connectFTP({ host, port, user, password, secure: protocol === 'ftps' });
        const targetFiles = files.length > 0 ? files : await scanFtpRecursive(ftpClient, targetPath);
        for (const f of targetFiles) {
          const pass = new PassThrough();
          const chunks = [];
          pass.on('data', c => chunks.push(c));
          await ftpClient.downloadTo(pass, f.path);
          archive.append(Buffer.concat(chunks), { name: f.path.replace(/^\/+/, '') });
        }
        await archive.finalize();
        ftpClient.close();
      }
      return;
    }

    return res.status(400).json({ success: false, error: 'Invalid action specified' });
  } catch (err) {
    if (ftpClient) try { ftpClient.close(); } catch (_) {}
    if (sftpClient) try { await sftpClient.end(); } catch (_) {}
    return res.status(500).json({ success: false, error: err.message || 'FTP Connection Failed' });
  }
};
