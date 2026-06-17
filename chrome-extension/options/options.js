'use strict';

const $ = (id) => document.getElementById(id);
const fields = ['edgeHost', 'edgePort', 'proxyHost', 'proxyPort', 'token'];

function setResult(text, kind) {
  const el = $('result');
  el.textContent = text;
  el.className = 'result' + (kind ? ' ' + kind : '');
}

function normalizeHost(raw) {
  if (!raw) return '';
  // Accept "http://10.0.0.5:8080" or "10.0.0.5" — keep just the host.
  let v = raw.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  v = v.split('/')[0].split(':')[0];
  return v;
}

async function load() {
  const c = await chrome.storage.local.get(fields);
  $('edgeHost').value = c.edgeHost || '';
  $('edgePort').value = c.edgePort || '';
  $('proxyHost').value = c.proxyHost || '';
  $('proxyPort').value = c.proxyPort || '';
  $('token').value = c.token || '';
}

async function save() {
  const edgeHost = normalizeHost($('edgeHost').value);
  if (!edgeHost) { setResult('Enter the gateway server IP / host.', 'err'); return false; }

  const data = {
    edgeHost,
    edgePort: parseInt($('edgePort').value, 10) || 8080,
    proxyHost: normalizeHost($('proxyHost').value) || edgeHost,
    proxyPort: parseInt($('proxyPort').value, 10) || 3128,
    token: $('token').value.trim(),
  };
  await chrome.storage.local.set(data);
  return true;
}

$('saveBtn').addEventListener('click', async () => {
  if (await save()) setResult('Saved. You can close this tab.', 'ok');
});

$('testBtn').addEventListener('click', async () => {
  if (!(await save())) return;
  setResult('Testing…', '');
  const res = await new Promise((resolve) =>
    chrome.runtime.sendMessage({ type: 'TEST_GATEWAY' }, resolve));
  if (res && res.ok) {
    setResult(`Connected — ${res.active}/${res.max} sessions in use, ${res.pingMs}ms.`, 'ok');
  } else {
    const why = res ? (res.reason || res.error || 'unreachable') : 'no response';
    setResult(`Could not reach gateway (${why}). Check IP, port, and token.`, 'err');
  }
});

document.addEventListener('DOMContentLoaded', load);
load();
