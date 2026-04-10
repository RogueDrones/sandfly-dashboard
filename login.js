const form      = document.getElementById('loginForm');
const submitBtn = document.getElementById('submitBtn');
const errorMsg  = document.getElementById('errorMsg');

const params  = new URLSearchParams(window.location.search);
const rawNext = params.get('next') || '/';
// Only allow same-origin relative paths — prevents open-redirect attacks
const nextPath = (rawNext.startsWith('/') && !rawNext.startsWith('//') && !rawNext.includes(':')) ? rawNext : '/';

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.add('visible');
}

function clearError() {
  errorMsg.classList.remove('visible');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();

  const email    = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  if (!email || !password) {
    showError('Please enter your email and password.');
    return;
  }

  submitBtn.disabled    = true;
  submitBtn.textContent = 'Signing in…';

  try {
    const res  = await fetch('/api/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, password }),
    });
    const data = await res.json();

    if (res.ok && data.ok) {
      window.location.href = nextPath;
    } else {
      showError(data.error || 'Sign in failed. Please try again.');
      submitBtn.disabled    = false;
      submitBtn.textContent = 'Sign In';
    }
  } catch {
    showError('Network error. Please check your connection and try again.');
    submitBtn.disabled    = false;
    submitBtn.textContent = 'Sign In';
  }
});
