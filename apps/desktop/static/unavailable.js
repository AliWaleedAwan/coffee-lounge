// Fills the unavailable screen for the reason the app passed in the query string.
const TEXT = {
  unreachable: {
    title: 'Server unavailable',
    tone: 'banner-warning',
    message: 'The counter app cannot reach the Coffee Lounge server.',
    steps: [
      'Check that the counter PC finished starting (it can take up to 3 minutes after a power cut).',
      'Check the network cable and the router lights.',
      'Waiter tablets and phones may still work: this screen only affects this PC.',
    ],
    retry: true,
  },
  starting: {
    title: 'Starting Coffee Lounge',
    tone: 'banner-warning',
    message: 'The app opens by itself as soon as everything below is running.',
    steps: [],
    retry: true,
  },
  certificate: {
    title: 'Server not trusted',
    tone: 'banner-danger',
    message:
      'The server did not prove it is the shop server (its security certificate is not the shop’s). Do not enter any password.',
    steps: ['Call the technician.', 'Do not change the date or certificate settings yourself.'],
    retry: true,
  },
  config: {
    title: 'Counter app not set up',
    tone: 'banner-danger',
    message: 'The counter app has no valid settings, so it does not know where the server is.',
    steps: ['Call the technician to run the installer again.'],
    retry: false,
  },
  other: {
    title: 'Could not open the app',
    tone: 'banner-warning',
    message: 'The staff app did not load.',
    steps: [
      'Wait a moment; the app tries again by itself.',
      'If this keeps happening, call the technician.',
    ],
    retry: true,
  },
};

const params = new URLSearchParams(window.location.search);
const reason = Object.hasOwn(TEXT, params.get('reason') ?? '') ? params.get('reason') : 'other';
const text = TEXT[reason];
const byId = (id) => document.getElementById(id);

document.title = `Coffee Lounge · ${text.title}`;
byId('title').textContent = text.title;
const message = byId('message');
message.textContent = text.message;
message.className = `banner ${text.tone}`;
for (const step of text.steps) {
  const li = document.createElement('li');
  li.textContent = step;
  byId('steps').append(li);
}
const detail = params.get('detail');
if (detail) {
  byId('detail').textContent = detail;
  byId('detail').hidden = false;
}
byId('version').textContent = window.coffeeLounge ? window.coffeeLounge.version : '';

const MARK = { ok: '✓', working: '…', problem: '!' };
window.coffeeLounge?.onServices?.((rows) => {
  const list = byId('services');
  list.replaceChildren(
    ...rows.map((row) => {
      const li = document.createElement('li');
      li.className = `service service-${row.state}`;
      li.dataset.service = row.id;
      const mark = document.createElement('span');
      mark.className = 'service-mark';
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = MARK[row.state];
      const label = document.createElement('strong');
      label.textContent = row.label;
      const message = document.createElement('span');
      message.textContent = row.message;
      li.append(mark, label, message);
      return li;
    }),
  );
  list.hidden = false;
});

const retry = byId('retry');
if (text.retry && window.coffeeLounge) {
  retry.addEventListener('click', () => {
    retry.disabled = true;
    retry.textContent = 'Trying…';
    window.coffeeLounge.retryNow();
    setTimeout(() => {
      retry.disabled = false;
      retry.textContent = 'Try again now';
    }, 2000);
  });
} else {
  retry.hidden = true;
  byId('auto').hidden = true;
}
