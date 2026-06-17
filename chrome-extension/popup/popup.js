'use strict';
/* Popup view. All privileged actions (proxy, tab management, session lifecycle)
   are delegated to the background service worker via messages. */

const $ = (id) => document.getElementById(id);

const els = {
  serverDot: $('serverDot'),
  serverStatus: $('serverStatus'),
  ping: $('pingValue'),
  active: $('activeValue'),
  free: $('freeValue'),
  vpnToggle: $('vpnToggle'),
  vpnState: $('vpnState'),
  vpnPulse: $('vpnPulse'),
  vpnStateText: $('vpnStateText'),
  vpnSubtitle: $('vpnSubtitle'),
  remoteBtn: $('remoteBtn'),
  settingsBtn: $('settingsBtn'),
  hostFoot: $('hostFoot'),
  toast: $('toast'),
};

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

function toast(text, isErr = false) {
  els.toast.textContent = text;
  els.toast.classList.toggle('err', isErr);
  els.toast.classList.add('show');
  setTimeout(() => els.toast.classList.remove('show'), 2600);
}

function renderVpn(on) {
  els.vpnToggle.setAttribute('aria-checked', String(on));
  els.vpnState.classList.toggle('on', on);
  els.vpnStateText.textContent = on
    ? 'Routing on — browser traffic via company gateway'
    : 'Routing off — traffic goes directly';
}

function renderStatus(s) {
  if (!s || !s.ok) {
    els.serverDot.className = 'dot bad';
    els.serverStatus.textContent = s && s.reason === 'unconfigured'
      ? 'No gateway set — open Settings'
      : 'Gateway unreachable';
    els.ping.textContent = '—';
    els.active.textContent = '—';
    els.free.textContent = '—';
    els.remoteBtn.disabled = true;
    return;
  }
  els.serverDot.className = 'dot ok';
  els.serverStatus.textContent = 'Connected to gateway';
  els.ping.textContent = s.pingMs != null ? `${s.pingMs}ms` : '—';
  els.active.textContent = s.active ?? '—';
  els.free.textContent = s.free ?? '—';
  els.remoteBtn.disabled = (s.free ?? 0) <= 0;
  if ((s.free ?? 0) <= 0) toast('Server at capacity — try again shortly.', true);
}

async function refresh() {
  const state = await send({ type: 'GET_STATE' });
  renderVpn(Boolean(state && state.vpnOn));
  els.hostFoot.textContent = state && state.host
    ? `${state.host}:${state.port}` : 'No gateway configured';

  if (!state || !state.configured) {
    renderStatus({ ok: false, reason: 'unconfigured' });
    return;
  }
  const status = await send({ type: 'GET_STATUS' });
  renderStatus(status);
}

els.vpnToggle.addEventListener('click', async () => {
  const next = els.vpnToggle.getAttribute('aria-checked') !== 'true';
  renderVpn(next); // optimistic
  const res = await send({ type: 'SET_VPN', on: next });
  if (!res || !res.ok) {
    renderVpn(!next);
    toast(res && res.error ? res.error : 'Could not change routing.', true);
  } else {
    toast(next ? 'Secure routing enabled.' : 'Secure routing disabled.');
  }
});

els.remoteBtn.addEventListener('click', async () => {
  els.remoteBtn.disabled = true;
  const prev = els.remoteBtn.innerHTML;
  els.remoteBtn.textContent = 'Provisioning isolated session…';
  const res = await send({ type: 'OPEN_REMOTE' });
  if (res && res.ok) {
    toast('Remote session opened in a new tab.');
    window.close();
  } else {
    els.remoteBtn.innerHTML = prev;
    els.remoteBtn.disabled = false;
    toast(res && res.error ? res.error : 'Could not start session.', true);
  }
});

els.settingsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());

document.addEventListener('DOMContentLoaded', refresh);
refresh();
