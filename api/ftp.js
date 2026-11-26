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

// Recursive delete helper for FTP (removes files and subdirectories)
async function deleteFtpRecursive(client, targetPath, isDirectoryHint = null) {
  const cleanPath = targetPath === '/' ? '/' : targetPath.replace(/\/+$/, '');
  if (cleanPath === '/') {
    throw new Error('Refusing to delete root directory /');
  }

  let isDir = isDirectoryHint;
  if (isDir === null || isDir === undefined) {
    const parentDir = cleanPath.includes('/') ? (cleanPath.slice(0, cleanPath.lastIndexOf('/')) || '/') : '/';
    const baseName = cleanPath.split('/').pop();
    const siblings = await client.list(parentDir);
    const match = siblings.find(entry => entry.name === baseName);
    if (!match) {
      throw new Error(`Target not found: ${cleanPath}`);
    }
    isDir = Boolean(match.isDirectory);
  }

  if (!isDir) {
    await client.remove(cleanPath);
    return;
  }

  const entries = await client.list(cleanPath);
  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..') continue;
    const childPath = `${cleanPath}/${entry.name}`;
    await deleteFtpRecursive(client, childPath, Boolean(entry.isDirectory));
  }
  await client.removeDir(cleanPath);
}

// Recursive delete helper for SFTP (removes files and subdirectories)
async function deleteSftpRecursive(sftp, targetPath) {
  const cleanPath = targetPath === '/' ? '/' : targetPath.replace(/\/+$/, '');
  if (cleanPath === '/') {
    throw new Error('Refusing to delete root directory /');
  }

  const stat = await sftp.stat(cleanPath);
  if (stat.isDirectory) {
    await sftp.rmdir(cleanPath, true);
  } else {
    await sftp.delete(cleanPath);
  }
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
    newPath,
    mode,
    itemType,
    content = '',
    files = []
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
    // 3. CREATE DIRECTORY (MKDIR)
    // ==========================================
    if (action === 'mkdir') {
      if (protocol === 'sftp') {
        sftpClient = await connectSFTP({ host, port, user, password });
        await sftpClient.mkdir(targetPath, true);
        await sftpClient.end();
      } else {
        ftpClient = await connectFTP({ host, port, user, password, secure: protocol === 'ftps' });
        await ftpClient.ensureDir(targetPath);
        ftpClient.close();
      }
      return res.status(200).json({ success: true, path: targetPath });
    }

    // ==========================================
    // 4. CREATE / OVERWRITE FILE (WRITE)
    // ==========================================
    if (action === 'write') {
      const contentBuffer = Buffer.from(String(content ?? ''), 'utf8');
      const parentDir = targetPath.includes('/')
        ? (targetPath.slice(0, targetPath.lastIndexOf('/')) || '/')
        : '/';

      if (protocol === 'sftp') {
        sftpClient = await connectSFTP({ host, port, user, password });
        if (parentDir && parentDir !== '/') {
          await sftpClient.mkdir(parentDir, true);
        }
        await sftpClient.put(contentBuffer, targetPath);
        await sftpClient.end();
      } else {
        ftpClient = await connectFTP({ host, port, user, password, secure: protocol === 'ftps' });
        if (parentDir && parentDir !== '/') {
          await ftpClient.ensureDir(parentDir);
        }
        const readableStream = new PassThrough();
        readableStream.end(contentBuffer);
        await ftpClient.uploadFrom(readableStream, targetPath);
        ftpClient.close();
      }
      return res.status(200).json({ success: true, path: targetPath, bytes: contentBuffer.length });
    }

    // ==========================================
    // 5. DELETE FILE OR FOLDER RECURSIVELY
    // ==========================================
    if (action === 'delete') {
      if (!targetPath || targetPath === '/') {
        return res.status(400).json({ success: false, error: 'Valid target path is required for delete' });
      }

      if (protocol === 'sftp') {
        sftpClient = await connectSFTP({ host, port, user, password });
        await deleteSftpRecursive(sftpClient, targetPath);
        await sftpClient.end();
      } else {
        ftpClient = await connectFTP({ host, port, user, password, secure: protocol === 'ftps' });
        const dirHint = itemType === 'folder' ? true : (itemType === 'file' ? false : null);
        await deleteFtpRecursive(ftpClient, targetPath, dirHint);
        ftpClient.close();
      }
      return res.status(200).json({ success: true, deleted: targetPath });
    }

    // ==========================================
    // 6. RENAME OR MOVE FILE / FOLDER
    // ==========================================
    if (action === 'rename') {
      if (!targetPath || !newPath) {
        return res.status(400).json({ success: false, error: 'Both path and newPath are required for rename' });
      }

      if (protocol === 'sftp') {
        sftpClient = await connectSFTP({ host, port, user, password });
        await sftpClient.rename(targetPath, newPath);
        await sftpClient.end();
      } else {
        ftpClient = await connectFTP({ host, port, user, password, secure: protocol === 'ftps' });
        await ftpClient.rename(targetPath, newPath);
        ftpClient.close();
      }
      return res.status(200).json({ success: true, from: targetPath, to: newPath });
    }

    // ==========================================
    // 7. CHANGE PERMISSIONS (CHMOD)
    // ==========================================
    if (action === 'chmod') {
      if (!targetPath || !mode) {
        return res.status(400).json({ success: false, error: 'Both path and mode (e.g. "0755" or "0644") are required' });
      }
      const octalString = String(mode).replace(/^0+/, '') || '644';
      const numericMode = parseInt(octalString, 8);
      if (Number.isNaN(numericMode)) {
        return res.status(400).json({ success: false, error: 'Invalid octal permission mode' });
      }

      if (protocol === 'sftp') {
        sftpClient = await connectSFTP({ host, port, user, password });
        await sftpClient.chmod(targetPath, numericMode);
        await sftpClient.end();
      } else {
        ftpClient = await connectFTP({ host, port, user, password, secure: protocol === 'ftps' });
        await ftpClient.send(`SITE CHMOD ${octalString} ${targetPath}`);
        ftpClient.close();
      }
      return res.status(200).json({ success: true, path: targetPath, mode: `0${octalString}` });
    }

    // ==========================================
    // 8. DOWNLOAD SINGLE FILE
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
    // 9. DOWNLOAD ALL (OR BATCH) AS ZIP
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
    return res.status(500).json({ success: false, error: err.message || 'FTP Operation Failed' });
  }
};
