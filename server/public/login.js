const { t, apply, toggle } = window.I18n;
apply();

const form = document.getElementById('login');
const error = document.getElementById('error');

document.getElementById('lang').addEventListener('click', toggle);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.textContent = '';
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: form.user.value, password: form.password.value }),
    });
    if (res.ok) return location.assign('/');
    error.textContent = t(res.status === 429 ? 'loginRateLimited' : res.status === 401 ? 'loginInvalid' : 'loginError');
    form.password.select();
  } catch {
    error.textContent = t('loginError');
  } finally {
    button.disabled = false;
  }
});

document.getElementById('user').focus();
