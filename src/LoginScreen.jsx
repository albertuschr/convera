import React, { useState } from 'react';
import { isEmail, checkPassword } from './services/validators.js';
import { login, register } from './services/backend.js';

const field = {
  width: '100%', height: 42, padding: '0 12px', border: '1px solid var(--border)', borderRadius: 8,
  background: 'var(--input)', color: 'var(--text)', fontFamily: 'inherit', fontSize: 14, outline: 'none', boxSizing: 'border-box',
};

// Layar masuk/daftar. Dipakai hanya saat VITE_BACKEND_ENABLED=true dan belum ada sesi.
export default function LoginScreen({ themeStyle, onAuthed }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '', workspaceName: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (key) => (event) => setForm((value) => ({ ...value, [key]: event.target.value }));
  const isRegister = mode === 'register';

  const submit = async (event) => {
    event.preventDefault();
    if (!isEmail(form.email)) return setError('Format email tidak valid');
    if (isRegister) {
      if (!form.name.trim()) return setError('Nama wajib diisi');
      const weak = checkPassword('x', form.password, form.password);
      if (weak && weak !== 'Password baru tidak boleh sama dengan yang lama') return setError(weak);
    } else if (!form.password) return setError('Isi password');
    setBusy(true);
    try {
      const data = isRegister
        ? await register({ name: form.name.trim(), email: form.email.trim(), password: form.password, ...(form.workspaceName.trim() ? { workspaceName: form.workspaceName.trim() } : {}) })
        : await login(form.email.trim(), form.password);
      setForm((value) => ({ ...value, password: '' }));
      onAuthed(data);
    } catch (e) {
      setError(e.message || 'Gagal masuk');
    }
    setBusy(false);
  };

  const labelStyle = { display: 'flex', flexDirection: 'column', gap: 7, fontSize: 13, fontWeight: 700 };
  return (
    <div style={{ ...themeStyle, minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, background: 'var(--bg, var(--surface2))', color: 'var(--text)', boxSizing: 'border-box' }}>
      <form onSubmit={submit} style={{ width: 'min(400px, 100%)', padding: 28, borderRadius: 14, background: 'var(--surface)', border: '1px solid var(--border)', boxSizing: 'border-box' }}>
        <h1 style={{ margin: '0 0 6px', fontSize: 22 }}>{isRegister ? 'Buat akun Convera' : 'Masuk ke Convera'}</h1>
        <p style={{ margin: '0 0 22px', color: 'var(--muted)', fontSize: 13 }}>{isRegister ? 'Akun pertama otomatis menjadi Owner workspace.' : 'Gunakan email dan password akun Anda.'}</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {isRegister ? <label style={labelStyle}>Nama lengkap<input value={form.name} onChange={set('name')} autoComplete="name" style={field} /></label> : null}
          <label style={labelStyle}>Email<input value={form.email} onChange={set('email')} type="email" autoComplete="email" style={field} /></label>
          <label style={labelStyle}>Password<input value={form.password} onChange={set('password')} type="password" autoComplete={isRegister ? 'new-password' : 'current-password'} style={field} /></label>
          {isRegister ? <label style={labelStyle}>Nama workspace (opsional)<input value={form.workspaceName} onChange={set('workspaceName')} style={field} /></label> : null}
        </div>
        {error ? <p role="alert" style={{ margin: '14px 0 0', color: 'var(--danger)', fontSize: 13 }}>{error}</p> : null}
        <button type="submit" disabled={busy} style={{ width: '100%', height: 44, marginTop: 20, border: 0, borderRadius: 8, background: 'var(--accent)', color: '#fff', fontFamily: 'inherit', fontSize: 14, fontWeight: 700, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.7 : 1 }}>
          {busy ? 'Memproses…' : isRegister ? 'Daftar' : 'Masuk'}
        </button>
        <button type="button" onClick={() => { setMode(isRegister ? 'login' : 'register'); setError(''); }} style={{ width: '100%', marginTop: 12, border: 0, background: 'transparent', color: 'var(--muted)', fontFamily: 'inherit', fontSize: 13, cursor: 'pointer' }}>
          {isRegister ? 'Sudah punya akun? Masuk' : 'Belum punya akun? Daftar'}
        </button>
      </form>
    </div>
  );
}
