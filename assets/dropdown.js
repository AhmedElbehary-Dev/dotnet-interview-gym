/* Custom accessible dropdown system for .NET Interview GYM
   Replaces native browser <select> OS popups with a Fluent-styled custom dropdown menu
   supporting RTL, keyboard navigation, dark/light themes, and automatic DOM synchronization. */
(function () {
  'use strict';

  const instances = new Map();

  function createCustomSelect(select) {
    if (!select || instances.has(select)) return instances.get(select);
    if (select.dataset.customized === 'true') return;
    select.dataset.customized = 'true';

    const wrapper = document.createElement('div');
    wrapper.className = 'custom-select';
    if (select.id) {
      wrapper.id = `${select.id}-custom-select`;
      wrapper.dataset.for = select.id;
    }

    // Trigger button
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'custom-select-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    if (select.id) trigger.id = `${select.id}-trigger`;

    const valueSpan = document.createElement('span');
    valueSpan.className = 'custom-select-value';

    const arrow = document.createElement('span');
    arrow.className = 'custom-select-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

    trigger.appendChild(valueSpan);
    trigger.appendChild(arrow);

    // Menu dropdown panel
    const menu = document.createElement('div');
    menu.className = 'custom-select-menu';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('tabindex', '-1');

    // Insert wrapper into DOM
    const parent = select.parentNode;
    parent.insertBefore(wrapper, select);
    wrapper.appendChild(select);
    wrapper.appendChild(trigger);
    wrapper.appendChild(menu);

    select.classList.add('custom-select-native');
    select.setAttribute('tabindex', '-1');
    select.setAttribute('aria-hidden', 'true');

    let isOpen = false;
    let highlightedIndex = -1;

    function getOptions() {
      return Array.from(select.options);
    }

    function syncOptions() {
      menu.innerHTML = '';
      const options = getOptions();
      const currentVal = select.value;
      let matchedIndex = options.findIndex(o => o.value === currentVal);
      if (matchedIndex < 0 && options.length > 0) matchedIndex = 0;

      options.forEach((opt, idx) => {
        const item = document.createElement('div');
        item.className = 'custom-select-option';
        item.setAttribute('role', 'option');
        item.setAttribute('data-value', opt.value);
        item.setAttribute('data-index', String(idx));

        const isSelected = idx === matchedIndex;
        item.setAttribute('aria-selected', String(isSelected));
        if (isSelected) {
          item.classList.add('is-selected');
          valueSpan.textContent = opt.textContent;
          highlightedIndex = idx;
        }

        const textSpan = document.createElement('span');
        textSpan.className = 'custom-select-text';
        textSpan.textContent = opt.textContent;

        const checkSpan = document.createElement('span');
        checkSpan.className = 'custom-select-check';
        checkSpan.setAttribute('aria-hidden', 'true');
        checkSpan.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

        item.appendChild(textSpan);
        item.appendChild(checkSpan);

        item.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          selectIndex(idx);
          close();
          trigger.focus();
        });

        item.addEventListener('mouseenter', () => {
          setHighlight(idx, false);
        });

        menu.appendChild(item);
      });

      if (options.length > 0 && matchedIndex >= 0) {
        valueSpan.textContent = options[matchedIndex].textContent;
      } else if (options.length === 0) {
        valueSpan.textContent = '';
      }
    }

    function selectIndex(index) {
      const options = getOptions();
      if (index < 0 || index >= options.length) return;
      const targetOpt = options[index];

      const valueChanged = select.value !== targetOpt.value;
      select.value = targetOpt.value;
      if (valueChanged) {
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }

      valueSpan.textContent = targetOpt.textContent;

      Array.from(menu.children).forEach((child, i) => {
        const isMatch = i === index;
        child.classList.toggle('is-selected', isMatch);
        child.setAttribute('aria-selected', String(isMatch));
      });
      setHighlight(index, true);
    }

    function setHighlight(index, scrollIntoView = false) {
      const items = Array.from(menu.children);
      items.forEach((item, i) => {
        item.classList.toggle('is-highlighted', i === index);
      });
      highlightedIndex = index;

      if (scrollIntoView && items[index]) {
        items[index].scrollIntoView({ block: 'nearest' });
      }
    }

    function open() {
      if (isOpen || select.disabled) return;
      instances.forEach(inst => {
        if (inst !== api) inst.close();
      });

      isOpen = true;
      wrapper.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');

      const options = getOptions();
      const currentIdx = options.findIndex(o => o.value === select.value);
      setHighlight(currentIdx >= 0 ? currentIdx : 0, true);
    }

    function close() {
      if (!isOpen) return;
      isOpen = false;
      wrapper.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
      const items = Array.from(menu.children);
      items.forEach(item => item.classList.remove('is-highlighted'));
    }

    function toggle() {
      if (isOpen) close();
      else open();
    }

    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggle();
    });

    menu.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    wrapper.addEventListener('click', (e) => {
      if (menu.contains(e.target)) {
        e.stopPropagation();
      }
    });

    // Keyboard accessibility
    trigger.addEventListener('keydown', (e) => {
      const options = getOptions();
      if (!options.length) return;

      if (e.key === 'ArrowDown' || e.key === 'Down') {
        e.preventDefault();
        if (!isOpen) {
          open();
        } else {
          const next = (highlightedIndex + 1) % options.length;
          setHighlight(next, true);
        }
      } else if (e.key === 'ArrowUp' || e.key === 'Up') {
        e.preventDefault();
        if (!isOpen) {
          open();
        } else {
          const prev = (highlightedIndex - 1 + options.length) % options.length;
          setHighlight(prev, true);
        }
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (isOpen) {
          if (highlightedIndex >= 0) selectIndex(highlightedIndex);
          close();
        } else {
          open();
        }
      } else if (e.key === 'Escape') {
        if (isOpen) {
          e.preventDefault();
          close();
        }
      } else if (e.key === 'Tab') {
        if (isOpen) close();
      } else if (e.key === 'Home') {
        if (isOpen) {
          e.preventDefault();
          setHighlight(0, true);
        }
      } else if (e.key === 'End') {
        if (isOpen) {
          e.preventDefault();
          setHighlight(options.length - 1, true);
        }
      }
    });

    // Sync if programmatic change occurs
    select.addEventListener('change', () => {
      const options = getOptions();
      const idx = options.findIndex(o => o.value === select.value);
      if (idx >= 0) {
        valueSpan.textContent = options[idx].textContent;
        Array.from(menu.children).forEach((child, i) => {
          const match = i === idx;
          child.classList.toggle('is-selected', match);
          child.setAttribute('aria-selected', String(match));
        });
      }
    });

    // Observe changes to <option> children
    const observer = new MutationObserver(() => {
      syncOptions();
    });
    observer.observe(select, { childList: true, subtree: true });

    syncOptions();

    const api = {
      open,
      close,
      sync: syncOptions,
      destroy() {
        observer.disconnect();
        wrapper.replaceWith(select);
        select.classList.remove('custom-select-native');
        delete select.dataset.customized;
        instances.delete(select);
      }
    };

    instances.set(select, api);
    return api;
  }

  // Global click outside listener
  document.addEventListener('click', (e) => {
    instances.forEach((inst, select) => {
      const wrapper = select.closest('.custom-select');
      if (wrapper && !wrapper.contains(e.target)) {
        inst.close();
      }
    });
  });

  // Global escape key listener
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      instances.forEach(inst => inst.close());
    }
  });

  function initAll() {
    document.querySelectorAll('label.field select, select.enhance-dropdown').forEach(sel => {
      createCustomSelect(sel);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }

  window.GymDropdown = {
    init: initAll,
    enhance: createCustomSelect,
    sync(select) {
      if (select && instances.has(select)) {
        instances.get(select).sync();
      } else {
        initAll();
      }
    }
  };
})();
