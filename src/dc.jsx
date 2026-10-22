import React from 'react';

// Base class the original design logic extends (state + setState bridge to React).
export class DCLogic {
  constructor(props) { this.props = props || {}; this.state = {}; this.__host = null; }
  setState(update, cb) { this.__host && this.__host.__setLogicState(update, cb); }
  forceUpdate() { this.__host && this.__host.forceUpdate(); }
  componentDidMount() {}
  componentDidUpdate() {}
  componentWillUnmount() {}
  renderVals() { return {}; }
}

const cssToObj = (css) => {
  const o = {};
  for (const d of css.split(';')) {
    const i = d.indexOf(':'); if (i < 0) continue;
    const p = d.slice(0, i).trim();
    o[p.startsWith('--') ? p : p.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = d.slice(i + 1).trim();
  }
  return o;
};
// style attr: string -> object, object passthrough
export const S = (v) => (typeof v === 'string' ? cssToObj(v) : v ?? undefined);
// sc-for list guard
export const L = (v) => (Array.isArray(v) ? v : []);
// {{ interpolation }} in text nodes
export const I = (v) => {
  if (v === undefined || v === null || typeof v === 'boolean') return null;
  if (React.isValidElement(v) || Array.isArray(v)) return <>{v}</>;
  return <span className="sc-interp">{String(v)}</span>;
};
