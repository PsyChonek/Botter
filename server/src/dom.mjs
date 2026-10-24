// A small DOM for the page context, so content.js can build its real panel
// headless. linkedom lacks a few form and <details> properties the panel uses;
// they are added here as attribute reflections, which also makes them show in
// the serialized HTML the dashboard mirrors.
import { parseHTML } from 'linkedom';

function reflectBoolean(proto, name) {
  Object.defineProperty(proto, name, {
    configurable: true,
    get() {
      return this.hasAttribute(name);
    },
    set(on) {
      if (on) this.setAttribute(name, '');
      else this.removeAttribute(name);
    },
  });
}

function patch(window) {
  const { HTMLElement, HTMLSelectElement, HTMLOptionElement, document } = window;

  // <details open> and disabled options and selects.
  reflectBoolean(HTMLElement.prototype, 'open');
  reflectBoolean(HTMLOptionElement.prototype, 'disabled');
  reflectBoolean(HTMLSelectElement.prototype, 'disabled');
  reflectBoolean(HTMLOptionElement.prototype, 'selected');
  Object.defineProperty(HTMLOptionElement.prototype, 'value', {
    configurable: true,
    get() {
      return this.getAttribute('value') ?? this.textContent;
    },
    set(value) {
      this.setAttribute('value', String(value));
    },
  });

  const options = (select) => [...select.querySelectorAll('option')];
  Object.defineProperties(HTMLSelectElement.prototype, {
    options: {
      configurable: true,
      get() {
        return options(this);
      },
    },
    selectedOptions: {
      configurable: true,
      get() {
        const all = options(this);
        const picked = all.filter((option) => option.selected);
        return picked.length ? picked.slice(0, 1) : all.slice(0, 1);
      },
    },
    value: {
      configurable: true,
      get() {
        return this.selectedOptions[0]?.value ?? '';
      },
      set(value) {
        for (const option of options(this)) option.selected = option.value === String(value);
      },
    },
  });
  HTMLSelectElement.prototype.add = function (option) {
    this.appendChild(option);
  };

  window.Option = function Option(text = '', value) {
    const option = document.createElement('option');
    option.textContent = text;
    if (value !== undefined) option.value = value;
    return option;
  };
}

export function createDom(bundleSrc) {
  const { window, document } = parseHTML('<!doctype html><html><head></head><body></body></html>');
  patch(window);
  // The bundle check finds the casino's bundle by its script tag.
  if (bundleSrc) {
    const script = document.createElement('script');
    script.setAttribute('src', bundleSrc);
    document.head.appendChild(script);
  }
  return { window, document };
}
