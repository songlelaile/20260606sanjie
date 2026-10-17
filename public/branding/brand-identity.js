/* Brand-only compatibility overlay for the currently published application. */
(function () {
  'use strict';
  var NAME = '少壮AI自动化';
  var scheduled = false;

  function row(size) {
    var el = document.createElement('span');
    el.className = 'sz-brand-lockup sz-brand-lockup--' + size;
    var primary = document.createElement('span');
    primary.className = 'sz-brand-primary';
    primary.textContent = NAME;
    var separator = document.createElement('span');
    separator.className = 'sz-brand-divider';
    separator.setAttribute('aria-hidden', 'true');
    var partner = document.createElement('span');
    partner.className = 'sz-brand-partner';
    partner.setAttribute('role', 'img');
    partner.setAttribute('aria-label', '联合开发：智篆');
    partner.title = '联合开发：智篆';
    el.append(primary, separator, partner);
    return el;
  }

  function apply() {
    scheduled = false;
    document.querySelectorAll('.sidebar a.brand').forEach(function (brand) {
      if (brand.querySelector('[data-sanjie-brand-identity]')) return;
      brand.setAttribute('aria-label', NAME + ' · 联合开发：智篆');
      if (brand.querySelector('.sz-brand-lockup')) return;
      var oldTitle = brand.querySelector('strong');
      if (!oldTitle) return;
      oldTitle.replaceChildren(row('sidebar'));
      brand.classList.add('sz-brand-host');
    });
    document.querySelectorAll('.mobile-shell-bar > span').forEach(function (brand) {
      if (brand.matches('[data-sanjie-brand-identity]') || brand.querySelector('[data-sanjie-brand-identity]')) return;
      if (!brand.querySelector('.sz-brand-lockup')) brand.replaceChildren(row('compact'));
    });
    document.querySelectorAll('.auth-hero-brand').forEach(function (brand) {
      if (brand.querySelector('[data-sanjie-brand-identity]')) return;
      if (brand.querySelector('.sz-brand-lockup')) return;
      var oldTitle = brand.querySelector('strong');
      if (!oldTitle) return;
      oldTitle.replaceChildren(row('login'));
      brand.classList.add('sz-brand-host');
    });
    document.querySelectorAll('.auth-card').forEach(function (card) {
      if (card.querySelector('[data-sanjie-brand-identity]')) return;
      if (card.querySelector('.sz-brand-mobile-login')) return;
      var mobile = document.createElement('div');
      mobile.className = 'sz-brand-mobile-login';
      mobile.appendChild(row('compact'));
      card.insertBefore(mobile, card.firstChild);
    });
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(apply);
  }

  function start() {
    apply();
    new MutationObserver(function (records) {
      if (records.some(function (r) { return r.type === 'childList'; })) schedule();
    }).observe(document.body, { childList: true, subtree: true });
  }
  // Let the published React application finish hydration before decorating it.
  if (document.readyState === 'complete') requestAnimationFrame(start);
  else window.addEventListener('load', function () { requestAnimationFrame(start); }, { once: true });
}());
