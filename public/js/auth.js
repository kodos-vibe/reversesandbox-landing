// Shared auth state detection for all pages
(function() {
  const navLinks = document.querySelector('.nav-links');
  if (!navLinks) return;

  fetch('/api/me')
    .then(r => r.json())
    .then(data => {
      if (!data.authenticated) {
        // Add Sign In button (only if not already present)
        if (!navLinks.querySelector('.auth-signin')) {
          const signIn = document.createElement('a');
          signIn.href = '/login';
          signIn.className = 'cta-link auth-signin';
          signIn.textContent = 'Sign In';
          navLinks.appendChild(signIn);
        }
        return;
      }

      // Authenticated — show user menu
      const existing = navLinks.querySelector('.cta-link:last-child');

      const userEl = document.createElement('div');
      userEl.style.cssText = 'display:flex;align-items:center;gap:12px;';

      const dashLink = document.createElement('a');
      dashLink.href = '/dashboard';
      dashLink.style.cssText = 'color:var(--text2);text-decoration:none;font-size:.9rem;';
      dashLink.textContent = 'Dashboard';

      const nameEl = document.createElement('span');
      nameEl.style.cssText = 'color:var(--text);font-size:.85rem;font-weight:500;';
      nameEl.textContent = data.user.name || data.user.email;

      const logoutLink = document.createElement('a');
      logoutLink.href = '/logout';
      logoutLink.style.cssText = 'color:var(--text2);text-decoration:none;font-size:.85rem;';
      logoutLink.textContent = 'Sign Out';

      userEl.appendChild(dashLink);
      userEl.appendChild(nameEl);
      userEl.appendChild(logoutLink);
      navLinks.appendChild(userEl);
    })
    .catch(() => {
      // Silently fail — auth detection is optional
    });
})();
