// Outlook / Microsoft 365 的 OAuth2 设备码流程（device code）
//
// 为什么用设备码：本应用通常部署在 NAS/内网，没有公网 HTTPS 域名，微软不接受
// http 或内网地址作为回调 URL。设备码流程不需要任何回调 —— 用户在自己电脑/手机上
// 打开 microsoft.com/devicelogin 输入 8 位码，服务端轮询换取 token，全程无需公网入口。
//
// scope 必须是 outlook.office.com 系列（IMAP/SMTP 的老式 Exchange Online scope），
// 不能混 graph 的 scope —— 混了拿到的 token 没有 IMAP 权限，连上去会认证失败。
import { system, saveSystem } from './store.js';

const AUTH_BASE = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const SCOPES = [
  'offline_access',
  'openid',
  'profile',
  'email',
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'https://outlook.office.com/SMTP.Send',
].join(' ');

// 这个页面直接对应「应用注册 → 新注册」，省得用户自己在门户里翻
export const REGISTER_URL = 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade';
export const DEVICE_LOGIN_URL = 'https://microsoft.com/devicelogin';

const CLIENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getOutlookClientId() {
  return String(system().settings.outlookClientId || '');
}

export function setOutlookClientId(raw) {
  const id = String(raw || '').trim();
  if (!CLIENT_ID_RE.test(id)) {
    throw Object.assign(new Error('应用 ID 格式不对：应该是 8-4-4-4-12 位、只含数字和字母的串（形如 12345678-1234-1234-1234-123456789abc）'), { status: 400 });
  }
  const sys = system();
  sys.settings.outlookClientId = id;
  saveSystem();
  return id;
}

async function parseJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return {}; }
}

// 把微软返回的错误码翻译成人话（界面上只看得到这句）
function oauthError(body, fallback) {
  const code = String(body?.error || '');
  const detail = String(body?.error_description || '');
  const aadsts = (detail.match(/AADSTS\d+/) || [])[0] || '';
  // 具体的 AADSTS 码优先于 error 字段的笼统兜底（invalid_request 会吞掉有价值的码）
  if (aadsts === 'AADSTS700016') return Object.assign(new Error('找不到这个应用：应用 ID 可能抄错了，或者应用建在了别的租户下'), { status: 400, code });
  if (aadsts === 'AADSTS7000218') return Object.assign(new Error('这个应用没开启「允许公共客户端流」，请在 Azure 门户 → 你的应用 → Authentication 拉到底打开后点 Save 重试'), { status: 400, code });
  if (aadsts === 'AADSTS500011') return Object.assign(new Error('应用缺少邮件权限：请在 Azure 门户 → API 权限 里添加 Office 365 Exchange Online 的 IMAP.AccessAsUser.All 与 SMTP.Send'), { status: 400, code });
  if (aadsts === 'AADSTS50194') return Object.assign(new Error('这个应用只允许自己组织的账户使用（注册时账户类型选错了）。改法：Azure 门户 → 你的应用 → Manifest（清单）→ 把 signInAudience 改为 AzureADandPersonalMicrosoftAccounts 并保存；或重新注册一个账户类型选「任何组织目录中的账户和个人 Microsoft 账户」的应用'), { status: 400, code });
  const known = {
    invalid_client: '应用 ID 不被微软接受：请确认复制的是「应用程序(客户端) ID」，并且该应用已开启「允许公共客户端流」',
    unauthorized_client: '这个应用不允许设备码登录：请在 Azure 门户 → 身份验证 → 打开「允许公共客户端流」后重试',
    invalid_grant: '授权已失效，请重新点击连接',
    invalid_request: '请求被微软拒绝：请检查①应用 ID 是否复制完整；②应用页面 Overview 里 Supported account types 是否为「any organizational directory and personal Microsoft accounts」；③Authentication 页的 Allow public client flows 是否已设为 Yes 并点了 Save',
    unsupported_grant_type: '授权方式不被支持，请确认应用已开启「允许公共客户端流」',
  };
  if (known[code]) return Object.assign(new Error(known[code]), { status: 400, code });
  return Object.assign(new Error(fallback || '微软登录服务返回了错误，请稍后重试'), { status: 400, code });
}

function netError(e) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return Object.assign(new Error('连接微软登录服务超时，请检查这台机器能否访问外网'), { status: 504 });
  }
  return Object.assign(new Error('无法连接微软登录服务：这台机器可能没有外网访问权限'), { status: 502 });
}

export async function startDeviceCode() {
  const clientId = getOutlookClientId();
  if (!clientId) throw Object.assign(new Error('还没有配置 Azure 应用 ID'), { status: 400, code: 'no_client_id' });

  let res;
  try {
    res = await fetch(`${AUTH_BASE}/devicecode`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, scope: SCOPES }).toString(),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) { throw netError(e); }

  const body = await parseJson(res);
  if (!res.ok) throw oauthError(body, '微软拒绝了这次授权请求');
  return {
    userCode: body.user_code,
    deviceCode: body.device_code,
    verificationUri: body.verification_uri || DEVICE_LOGIN_URL,
    expiresIn: Number(body.expires_in) || 900,
    interval: Math.max(3, Number(body.interval) || 5),
    message: body.message || '',
  };
}

/**
 * 轮询换 token。返回 { pending: true } 表示用户还没完成登录，前端继续等。
 */
export async function pollDeviceCode(deviceCode) {
  const clientId = getOutlookClientId();
  if (!clientId) throw Object.assign(new Error('还没有配置 Azure 应用 ID'), { status: 400, code: 'no_client_id' });

  let res;
  try {
    res = await fetch(`${AUTH_BASE}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: clientId,
        device_code: deviceCode,
      }).toString(),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) { throw netError(e); }

  const body = await parseJson(res);
  if (res.ok && body.access_token) {
    return {
      pending: false,
      token: {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
        email: emailFromToken(body.access_token) || emailFromIdToken(body.id_token) || '',
        clientId,
      },
    };
  }

  const code = String(body.error || '');
  if (code === 'authorization_pending') return { pending: true, reason: 'pending' };
  if (code === 'slow_down') return { pending: true, reason: 'slow_down' };
  if (code === 'authorization_declined') throw Object.assign(new Error('你在微软页面上取消了授权'), { status: 400, code });
  if (code === 'expired_token') throw Object.assign(new Error('这串验证码已过期，请重新获取'), { status: 400, code });
  if (code === 'bad_verification_code') throw Object.assign(new Error('验证码不在有效期内，请重新获取'), { status: 400, code });
  throw oauthError(body, '授权失败，请重试');
}

export async function refreshAccessToken(refreshToken, clientId = getOutlookClientId()) {
  if (!clientId) throw Object.assign(new Error('还没配置 Azure 应用 ID，无法续期 Outlook 授权'), { status: 400, code: 'no_client_id' });
  if (!refreshToken) throw Object.assign(new Error('Outlook 授权已失效，请重新添加这个账号'), { status: 401, code: 'no_refresh_token' });

  let res;
  try {
    res = await fetch(`${AUTH_BASE}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refreshToken,
        scope: SCOPES,
      }).toString(),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) { throw netError(e); }

  const body = await parseJson(res);
  if (res.ok && body.access_token) {
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token || refreshToken,
      expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
    };
  }
  if (String(body.error) === 'invalid_grant') {
    throw Object.assign(new Error('Outlook 授权已失效（可能改过密码或撤销了授权），请重新添加这个账号'), { status: 401, code: 'invalid_grant' });
  }
  throw oauthError(body, 'Outlook 授权续期失败');
}

// ---------- 从 JWT 里取邮箱地址（不校验签名，只用来预填显示名） ----------
function jwtPayload(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch { return null; }
}

function emailFromToken(accessToken) {
  const p = jwtPayload(accessToken);
  return p?.preferred_username || p?.upn || p?.unique_name || '';
}

function emailFromIdToken(idToken) {
  const p = jwtPayload(idToken);
  return p?.preferred_username || p?.email || '';
}
