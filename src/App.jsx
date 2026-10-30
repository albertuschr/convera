import React from 'react';
import Logic from './Logic.js';
import Template from './Template.jsx';
import defaults from './defaults.json';
import { load, save, reset, clear } from './services/storage.js';
import ProfilePanel from './ProfilePanel.jsx';
import LoginScreen from './LoginScreen.jsx';
import { appConfig } from './services/config.js';
import { setUnauthorizedHandler } from './services/api.js';
import { updateProfile, getSession, logout, setActiveWorkspace } from './services/backend.js';
// test

// Host: owns the design's logic instance (state, timers, handlers) and renders the template with its values.
export default class App extends React.Component {
  constructor(props) {
    super(props);
    this.props_ = { ...defaults, ...props };
    this.logic = new Logic(this.props_);
    this.logic.__host = this;
    // pulihkan data tersimpan; event yang masih "Mengirim" saat halaman ditutup dianggap gagal
    const saved = load();
    if (saved.kvNew) saved.kvNew = saved.kvNew.map((k) => (k.status === 'Mengirim' ? { ...k, status: 'Gagal', err: 'Terputus sebelum terkirim' } : k));
    this.logic.state = { ...this.logic.state, ...saved };
    // auth: 'off' = mode demo (tanpa login) | 'loading' | 'in' | 'out'
    this.state = { v: 0, profileOpen: false, auth: appConfig.backendEnabled ? 'loading' : 'off' };
    if (appConfig.backendEnabled) setUnauthorizedHandler(() => this.setState({ auth: 'out', profileOpen: false }));
    window.convera = { reset, state: () => this.logic.state };
  }
  __setLogicState(update, cb) {
    const prev = this.logic.state;
    const patch = typeof update === 'function' ? update(prev) : update;
    this.logic.state = { ...prev, ...patch };
    save(this.logic.state);
    this.setState((s) => ({ v: s.v + 1 }), cb);
  }
  openProfile = (event) => {
    if (event) event.preventDefault();
    this.logic.state = { ...this.logic.state, menu: null };
    this.setState({ profileOpen: true });
  };
  handleShellClick = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const link = target ? target.closest('a') : null;
    if (!link) return;
    const label = link.textContent.trim();
    if (label === 'Profil saya') {
      this.openProfile(event);
    } else if (label === 'Keluar' && appConfig.backendEnabled) {
      event.preventDefault();
      this.doLogout();
    }
  };
  // Kembalikan state logic ke awal dan hapus data lokal, agar data satu akun tidak terlihat oleh akun lain di browser yang sama.
  resetLocal = () => {
    clear();
    this.logic.state = { ...new Logic(this.props_).state, width: this.logic.state.width };
  };
  applySession = (data) => {
    const user = data?.user || {};
    const ws = data?.workspaces?.[0];
    setActiveWorkspace(ws?.id);
    if (this.logic.state.owner !== user.id) this.resetLocal();
    this.__setLogicState({
      owner: user.id,
      account: { role: ws?.role, wsName: ws?.name },
      profile: { name: user.name || '', email: user.email || '', phone: user.phone || '' },
    });
    this.setState({ auth: 'in' });
    this.logic.load();
  };
  doLogout = () => {
    logout().catch(() => {}).finally(() => { setActiveWorkspace(null); this.resetLocal(); this.setState({ auth: 'out', profileOpen: false }); });
  };
  saveProfile = async (profile) => {
    const savedProfile = await updateProfile(profile);
    this.__setLogicState({ profile: savedProfile });
  };
  componentDidMount() {
    this.logic.componentDidMount();
    if (appConfig.backendEnabled) getSession().then(this.applySession).catch(() => this.setState({ auth: 'out' }));
  }
  componentWillUnmount() { this.logic.componentWillUnmount(); }
  render() {
    this.logic.props = this.props_;
    const vals = { ...this.props_, ...(this.logic.renderVals() || {}) };
    if (this.state.auth === 'loading') return <div className="sc-host" style={{ ...vals.rootStyle, minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>Memuat…</div>;
    if (this.state.auth === 'out') return <div className="sc-host"><LoginScreen themeStyle={vals.rootStyle} onAuthed={this.applySession} /></div>;
    return (
      <div className="sc-host" onClickCapture={this.handleShellClick}>
        <Template v={vals} />
        {this.state.profileOpen ? <ProfilePanel profile={this.logic.state.profile} themeStyle={vals.rootStyle} onSave={this.saveProfile} onClose={() => this.setState({ profileOpen: false })} /> : null}
      </div>
    );
  }
}
