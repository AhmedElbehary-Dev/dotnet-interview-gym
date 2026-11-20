/* Interview Gym UI helpers. MicroModal handles focus trapping when available;
   the accessible in-project fallback allows dialogs to work without CDN access. */
(function () {
  'use strict';
  const root = document.getElementById('gym-confirm');
  const title = document.getElementById('gym-modal-title');
  const message = document.getElementById('gym-modal-message');
  const yes = document.getElementById('gym-modal-yes');
  const no = document.getElementById('gym-modal-no');
  const toastWrap = document.getElementById('gym-toast-wrap');
  let resolvePending = null;
  let previousFocus = null;
  let fallbackKeydown = null;

  function microModalAvailable() {
    return typeof window.MicroModal !== 'undefined' && typeof window.MicroModal.show === 'function';
  }
  function finish(result) {
    if (!resolvePending) return;
    const finishPromise = resolvePending;
    resolvePending = null;
    if (microModalAvailable()) {
      try { window.MicroModal.close('gym-confirm'); } catch (e) { console.error(e); }
    }
    root.classList.remove('is-open');
    root.setAttribute('aria-hidden', 'true');
    if (fallbackKeydown) document.removeEventListener('keydown', fallbackKeydown);
    fallbackKeydown = null;
    document.body.style.overflow = '';
    if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
    finishPromise(result);
  }
  yes.addEventListener('click', () => finish(true));
  no.addEventListener('click', () => finish(false));
  root.querySelector('.gym-modal__overlay').addEventListener('click', () => finish(false));

  function showModal() {
    previousFocus = document.activeElement;
    if (microModalAvailable()) {
      try {
        window.MicroModal.show('gym-confirm', {
          disableScroll: true,
          onClose: () => {
            if (resolvePending) finish(false);
          }
        });
        yes.focus();
        return;
      } catch (error) { console.warn('MicroModal fallback:', error); }
    }
    root.classList.add('is-open');
    root.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    fallbackKeydown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
      if (event.key === 'Tab') {
        const first = yes, last = no;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first.focus();
        }
      }
    };
    document.addEventListener('keydown', fallbackKeydown);
    yes.focus();
  }
  function confirm(titleText, messageText, confirmText = 'تأكيد') {
    if (resolvePending) return Promise.resolve(false);
    title.textContent = String(titleText);
    message.textContent = String(messageText);
    yes.textContent = String(confirmText);
    return new Promise(resolve => {
      resolvePending = resolve;
      showModal();
    });
  }
  function notify(text, type = 'info', duration = 3300) {
    const node = document.createElement('div');
    node.className = `gym-toast${type === 'warn' ? ' warn' : ''}`;
    node.textContent = String(text);
    toastWrap.appendChild(node);
    setTimeout(() => node.remove(), duration);
  }
  window.GymUI = Object.freeze({ confirm, notify });
}());
