import React, { useState } from 'react';
import { isEmail, isPhone, checkPassword } from './services/validators.js';

const fieldStyle = {
  width: '100%',
  height: 42,
  padding: '0 12px',
  border: '1px solid var(--border)',
  borderRadius: 8,
  background: 'var(--input)',
  color: 'var(--text)',
  fontFamily: 'inherit',
  fontSize: 14,
  outline: 'none',
  boxSizing: 'border-box',
};

export default function ProfilePanel({ profile, themeStyle, onSave, onClose }) {
  const [form, setForm] = useState({ name: '', email: '', phone: '', ...profile });
  const [passwords, setPasswords] = useState({ current: '', next: '', again: '' });
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const update = (key) => (event) => setForm((value) => ({ ...value, [key]: event.target.value }));
  const updatePassword = (key) => (event) => setPasswords((value) => ({ ...value, [key]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    if (!form.name.trim()) return setError('Nama wajib diisi');
    if (!isEmail(form.email)) return setError('Format email tidak valid');
    if (form.phone && !isPhone(form.phone)) return setError('Nomor telepon tidak valid');
    if (passwords.current || passwords.next || passwords.again) {
      const passwordError = checkPassword(passwords.current, passwords.next, passwords.again);
      if (passwordError) return setError(passwordError);
    }
    setSaving(true);
    try {
      await onSave({
        name: form.name.trim(),
        email: form.email.trim().toLowerCase(),
        phone: form.phone.trim(),
        ...(passwords.next ? { passwordUpdatedAt: new Date().toISOString() } : {}),
      });
    } catch (saveError) {
      setSaving(false);
      return setError(saveError.message || 'Profil tidak dapat disimpan');
    }
    setSaving(false);
    setPasswords({ current: '', next: '', again: '' });
    setError('');
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2500);
  };

  return (
    <div role="presentation" onMouseDown={onClose} style={{ ...themeStyle, position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,.35)', display: 'flex', justifyContent: 'flex-end' }}>
      <section role="dialog" aria-modal="true" aria-labelledby="profile-title" onMouseDown={(event) => event.stopPropagation()} style={{ ...themeStyle, width: 'min(460px, 100%)', height: '100%', overflowY: 'auto', padding: 28, background: 'var(--surface)', color: 'var(--text)', boxSizing: 'border-box', boxShadow: '-20px 0 50px -30px rgba(0,0,0,.5)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 26 }}>
          <div>
            <h2 id="profile-title" style={{ margin: 0, fontSize: 20 }}>Profil saya</h2>
            <p style={{ margin: '6px 0 0', color: 'var(--muted)', fontSize: 13 }}>Data profil tersimpan di browser ini.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Tutup profil" style={{ border: 0, background: 'var(--surface2)', color: 'var(--text)', borderRadius: 8, width: 34, height: 34, cursor: 'pointer', fontSize: 20 }}>×</button>
        </div>
        <form onSubmit={submit}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {[['name', 'Nama lengkap'], ['email', 'Email'], ['phone', 'Nomor telepon']].map(([key, label]) => (
              <label key={key} style={{ display: 'flex', flexDirection: 'column', gap: 7, fontSize: 13, fontWeight: 700 }}>
                {label}
                <input value={form[key]} onChange={update(key)} type={key === 'email' ? 'email' : key === 'phone' ? 'tel' : 'text'} style={fieldStyle} />
              </label>
            ))}
          </div>
          <div style={{ borderTop: '1px solid var(--border)', margin: '26px 0 18px', paddingTop: 22 }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 15 }}>Ubah password</h3>
            <p style={{ margin: '0 0 16px', color: 'var(--muted)', fontSize: 12 }}>Kosongkan jika tidak ingin mengubah password.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {[['current', 'Password saat ini'], ['next', 'Password baru'], ['again', 'Ulangi password baru']].map(([key, label]) => (
                <label key={key} style={{ display: 'flex', flexDirection: 'column', gap: 7, fontSize: 13, fontWeight: 700 }}>
                  {label}
                  <input value={passwords[key]} onChange={updatePassword(key)} type="password" autoComplete="new-password" style={fieldStyle} />
                </label>
              ))}
            </div>
          </div>
          {error ? <p role="alert" style={{ margin: '0 0 14px', color: 'var(--danger)', fontSize: 13 }}>{error}</p> : null}
          {saved ? <p role="status" style={{ margin: '0 0 14px', color: 'var(--okFg)', fontSize: 13 }}>Profil berhasil disimpan.</p> : null}
          <button type="submit" disabled={saving} style={{ width: '100%', height: 42, border: 0, borderRadius: 8, background: 'var(--accent)', color: '#fff', fontFamily: 'inherit', fontWeight: 800, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1 }}>{saving ? 'Menyimpan…' : 'Simpan perubahan'}</button>
        </form>
      </section>
    </div>
  );
}
