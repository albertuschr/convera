import React from 'react';
import Logic from './Logic.js';
import Template from './Template.jsx';
import defaults from './defaults.json';
import { load, save, reset } from './services/storage.js';
import ProfilePanel from './ProfilePanel.jsx';
import { updateProfile } from './services/backend.js';
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
    this.state = { v: 0, profileOpen: false };
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
    }
  };
  saveProfile = async (profile) => {
    const savedProfile = await updateProfile(profile);
    this.__setLogicState({ profile: savedProfile });
  };
  componentDidMount() { this.logic.componentDidMount(); }
  componentWillUnmount() { this.logic.componentWillUnmount(); }
  render() {
    this.logic.props = this.props_;
    const vals = { ...this.props_, ...(this.logic.renderVals() || {}) };
    return (
      <div className="sc-host" onClickCapture={this.handleShellClick}>
        <Template v={vals} />
        {this.state.profileOpen ? <ProfilePanel profile={this.logic.state.profile} themeStyle={vals.rootStyle} onSave={this.saveProfile} onClose={() => this.setState({ profileOpen: false })} /> : null}
      </div>
    );
  }
}
