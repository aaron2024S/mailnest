// 假 SMTP 服务器：收下 nodemailer 真正发出的报文，不往任何真实邮箱发信。
//
// 只实现 nodemailer 会用到的那几条：EHLO / AUTH LOGIN / MAIL / RCPT / DATA / QUIT。
// 刻意不在 EHLO 里声明 STARTTLS，否则它会尝试把连接升级成 TLS。
//
// send.mjs 和 draft.mjs 都用这一个，避免两份实现各自漂移。
import net from 'node:net';

export function startFakeSmtp() {
  const received = [];
  const server = net.createServer((conn) => {
    let mode = 'cmd';        // cmd | user | pass
    let acc = Buffer.alloc(0);
    let chunks = [];
    let inData = false;

    const send = (s) => { try { conn.write(`${s}\r\n`); } catch { /* 客户端已断开 */ } };

    const onLine = (l) => {
      const up = l.toUpperCase();
      if (mode === 'user') { mode = 'pass'; return send('334 UGFzc3dvcmQ6'); }
      if (mode === 'pass') { mode = 'cmd'; return send('235 2.7.0 Authentication successful'); }
      if (up.startsWith('EHLO')) return conn.write('250-test.local\r\n250-AUTH LOGIN PLAIN\r\n250 OK\r\n');
      if (up.startsWith('HELO')) return send('250 test.local');
      if (up.startsWith('AUTH LOGIN')) { mode = 'user'; return send('334 VXNlcm5hbWU6'); }
      if (up.startsWith('AUTH PLAIN')) return send('235 2.7.0 Authentication successful');
      if (up.startsWith('MAIL FROM') || up.startsWith('RCPT TO')) return send('250 2.1.0 Ok');
      if (up === 'DATA') { inData = true; chunks = []; return send('354 End data with <CR><LF>.<CR><LF>'); }
      if (up === 'QUIT') { send('221 2.0.0 Bye'); return conn.end(); }
      if (up === 'RSET' || up === 'NOOP') return send('250 2.0.0 Ok');
      return send('250 2.0.0 Ok');
    };

    conn.write('220 test.local ESMTP ready\r\n');
    conn.on('data', (chunk) => {
      if (inData) {
        chunks.push(chunk);
        const all = Buffer.concat(chunks);
        const end = all.indexOf('\r\n.\r\n');
        if (end < 0) return;                       // 报文还没收完
        received.push(all.subarray(0, end).toString('utf8'));
        inData = false;
        chunks = [];
        send('250 2.0.0 Ok: queued');
        const rest = all.subarray(end + 5).toString('utf8');
        if (/QUIT/i.test(rest)) { send('221 2.0.0 Bye'); conn.end(); }
        return;
      }
      acc = Buffer.concat([acc, chunk]);
      let i;
      while ((i = acc.indexOf('\r\n')) >= 0) {
        const l = acc.subarray(0, i).toString('utf8');
        acc = acc.subarray(i + 2);
        onLine(l);
      }
    });
    conn.on('error', () => { /* 测试结束时的正常断开 */ });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, received, port: server.address().port }));
  });
}
