import { useState, useMemo, useCallback, useEffect } from "react";
import { BarChart, Bar, LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, PieChart, Pie, ComposedChart, Legend, ReferenceLine } from "recharts";

/* ═══════════════════════════════════════════════════════════════
   CONSTANTS & DEFAULTS
   ═══════════════════════════════════════════════════════════════ */
const MO = 36;
const C = {
  bg: "#05080f", card: "#0c1220", card2: "#111a2e", border: "#1a2540", borderLight: "#243355",
  accent: "#00e5a0", accent2: "#6c8cff", accent3: "#00c2ff", warn: "#ffb224", danger: "#ff4d6a",
  text: "#e8ecf4", textM: "#8b9dc3", textD: "#4e6080", input: "#0a0f1c",
  green: "#00e5a0", red: "#ff4d6a", blue: "#6c8cff", cyan: "#00c2ff", orange: "#ffb224", purple: "#b18cff",
};
const G1 = `linear-gradient(135deg, ${C.accent} 0%, ${C.accent3} 100%)`;
const G2 = `linear-gradient(135deg, ${C.accent2} 0%, ${C.purple} 100%)`;

const baseRetention = [1,.96,.92,.89,.86,.84,.82,.80,.78,.76,.74,.72,.70,.69,.68,.67,.66,.65,.64,.63,.62,.61,.60,.59,.58,.57,.57,.56,.56,.55,.55,.54,.54,.53,.53,.52];
const scenarioMod = { 1: { g:-.01, ch:.02, sm:-.05, ex:-.005 }, 2: { g:0, ch:0, sm:0, ex:0 }, 3: { g:.02, ch:-.01, sm:.05, ex:.01 } };

const defaultCo = () => ({
  name: "NewCo",
  // ── Customer ──
  initialCust: 500, baseNewCust: 50, custGrowth: .03,
  retentionType: "standard", // standard | aggressive | conservative | custom
  customRetM6: .84, customRetM12: .70, customRetM24: .58, customRetM36: .52,
  // ── Revenue ──
  baseARPU: 150, arpuGrowth: .002, expansionRate: .03, contractionRate: .01,
  // ── Cost Structure ──
  cogsP: .25, smP: .40, rdP: .20, gaP: .10, daP: .02, taxRate: .25,
  // ── Working Capital ──
  dso: 45, dpo: 30, prepaidMonths: .5, deferredRevMonths: 1.5,
  // ── CapEx ──
  capexP: .03, startingPPE: 100000,
  // ── Cash & Debt ──
  startingCash: 2000000,
  hasRevolver: true, revolverLimit: 500000, revolverRate: .08, revolverDrawThreshold: 200000,
  hasTermDebt: false, termDebtAmount: 0, termDebtRate: .06, termDebtTenure: 36,
  // ── Equity Rounds ──
  rounds: [
    { month: 12, amount: 5000000, preMoneyMultiple: 15, name: "Series A" },
  ],
  // ── Valuation ──
  wacc: .15, termGrowth: .03, arrMult: 15, revMult: 12,
  // ── Scenario ──
  scenario: 2,
  // ── Fundraising ──
  minCashRunway: 6, targetRaiseMonths: 18,
});

/* ═══════════════════════════════════════════════════════════════
   FINANCIAL ENGINE
   ═══════════════════════════════════════════════════════════════ */
function getRetentionCurve(co) {
  if (co.retentionType === "aggressive") return baseRetention.map((r,i) => Math.min(1, r + .03));
  if (co.retentionType === "conservative") return baseRetention.map((r,i) => Math.max(0, r - .05));
  if (co.retentionType === "custom") {
    let curve = [1];
    const pts = [[0,1],[5,co.customRetM6],[11,co.customRetM12],[23,co.customRetM24],[35,co.customRetM36]];
    for (let m = 1; m < MO; m++) {
      let lo = pts[0], hi = pts[pts.length-1];
      for (let k = 0; k < pts.length-1; k++) { if (m >= pts[k][0] && m <= pts[k+1][0]) { lo = pts[k]; hi = pts[k+1]; break; } }
      let t = hi[0] === lo[0] ? 1 : (m - lo[0]) / (hi[0] - lo[0]);
      curve.push(Math.max(0, Math.min(1, lo[1] + t * (hi[1] - lo[1]))));
    }
    return curve;
  }
  return [...baseRetention];
}

function runModel(co) {
  const sc = scenarioMod[co.scenario] || scenarioMod[2];
  const eg = co.custGrowth + sc.g;
  const ech = sc.ch;
  const esm = co.smP + sc.sm;
  const eex = co.expansionRate + sc.ex;
  const ret = getRetentionCurve(co);
  const mChurn = Math.max(0, 1 - (ret[1] || .96) + ech);

  // Customer engine
  let nc = [], arpu = [];
  for (let i = 0; i < MO; i++) {
    nc[i] = i === 0 ? co.baseNewCust : nc[i-1] * (1 + eg);
    arpu[i] = i === 0 ? co.baseARPU : arpu[i-1] * (1 + co.arpuGrowth);
  }
  let ac = [];
  for (let m = 0; m < MO; m++) {
    let t = co.initialCust * Math.max(0, (ret[Math.min(m, 35)] || .5) - (m > 0 ? ech : 0));
    for (let c = 0; c <= m; c++) {
      let age = m - c;
      t += nc[c] * Math.max(0, (ret[Math.min(age, 35)] || .5) - (age > 0 ? ech : 0));
    }
    ac[m] = Math.max(0, t);
  }

  // Revenue
  let rev = ac.map((c, i) => c * arpu[i]);
  let cogs = rev.map(r => r * co.cogsP);
  let gp = rev.map((r, i) => r - cogs[i]);
  let sm = rev.map(r => r * esm);
  let rd = rev.map(r => r * co.rdP);
  let ga = rev.map(r => r * co.gaP);
  let da = rev.map(r => r * co.daP);
  let totalOpex = sm.map((s, i) => s + rd[i] + ga[i]);

  // MRR/ARR
  let sMRR=[], nMRR=[], exMRR=[], coMRR=[], chMRR=[], eMRR=[], arr=[];
  for (let i = 0; i < MO; i++) {
    sMRR[i] = i === 0 ? co.initialCust * co.baseARPU : eMRR[i-1];
    nMRR[i] = nc[i] * arpu[i];
    exMRR[i] = sMRR[i] * eex;
    coMRR[i] = sMRR[i] * co.contractionRate;
    chMRR[i] = sMRR[i] * mChurn;
    eMRR[i] = sMRR[i] + nMRR[i] + exMRR[i] - coMRR[i] - chMRR[i];
    arr[i] = eMRR[i] * 12;
  }

  // Working Capital
  let arAcc = rev.map(r => r * co.dso / 30);
  let ap = [];
  for (let i = 0; i < MO; i++) ap[i] = (cogs[i] + totalOpex[i]) * co.dpo / 30;
  let prepaid = rev.map(r => r * co.prepaidMonths * co.gaP);
  let defRev = rev.map(r => r * co.deferredRevMonths);
  let nwc = arAcc.map((a, i) => a + prepaid[i] - ap[i] - defRev[i]);
  let chNWC = nwc.map((n, i) => i === 0 ? n : n - nwc[i-1]);

  // P&L with interest
  let interestExp = new Array(MO).fill(0);
  let ebitda = gp.map((g, i) => g - totalOpex[i]);
  let ebit = ebitda.map((e, i) => e - da[i]);

  // Equity injections
  let equityIn = new Array(MO).fill(0);
  let roundLog = [];
  for (const rd2 of (co.rounds || [])) {
    let m = Math.max(0, Math.min(MO-1, rd2.month - 1));
    equityIn[m] += rd2.amount;
    roundLog.push({ month: m+1, ...rd2, postMoney: (arr[m] || 0) * rd2.preMoneyMultiple + rd2.amount });
  }

  // Term debt schedule
  let termDebtBal = new Array(MO).fill(0);
  let termPrincipal = new Array(MO).fill(0);
  let termInterest = new Array(MO).fill(0);
  if (co.hasTermDebt && co.termDebtAmount > 0) {
    let monthlyRate = co.termDebtRate / 12;
    let pmt = co.termDebtAmount * monthlyRate / (1 - Math.pow(1 + monthlyRate, -co.termDebtTenure));
    for (let i = 0; i < MO; i++) {
      let bal = i === 0 ? co.termDebtAmount : termDebtBal[i-1];
      if (bal <= 0) { termDebtBal[i] = 0; continue; }
      let intPay = bal * monthlyRate;
      let prinPay = Math.min(bal, pmt - intPay);
      termInterest[i] = intPay;
      termPrincipal[i] = prinPay;
      termDebtBal[i] = bal - prinPay;
    }
  }

  // Revolver + cash flow (iterative)
  let capex = rev.map(r => r * co.capexP);
  let ppe = [];
  let netInc = [], taxes = [], fcf = [], cash = [], revolverBal = [];
  let revolverDraw = new Array(MO).fill(0);
  let revolverRepay = new Array(MO).fill(0);
  let revolverInt = new Array(MO).fill(0);

  for (let i = 0; i < MO; i++) {
    // Interest from revolver (prior balance)
    let prevRevBal = i === 0 ? 0 : revolverBal[i-1];
    revolverInt[i] = prevRevBal * co.revolverRate / 12;
    interestExp[i] = revolverInt[i] + termInterest[i];

    // P&L
    let ebitHere = ebit[i] - interestExp[i];
    taxes[i] = Math.max(0, ebitHere * co.taxRate);
    netInc[i] = ebitHere - taxes[i];

    // Cash flow from operations
    let cfo = netInc[i] + da[i] - chNWC[i];
    let cfi = -capex[i];
    let cff_equity = equityIn[i];
    let cff_termDebt = -termPrincipal[i];

    // Pre-revolver cash
    ppe[i] = (i === 0 ? co.startingPPE : ppe[i-1]) + capex[i] - da[i];
    let preCash = (i === 0 ? co.startingCash : cash[i-1]) + cfo + cfi + cff_equity + cff_termDebt;

    // Revolver logic
    revolverBal[i] = prevRevBal;
    if (co.hasRevolver) {
      if (preCash < co.revolverDrawThreshold && revolverBal[i] < co.revolverLimit) {
        let draw = Math.min(co.revolverLimit - revolverBal[i], co.revolverDrawThreshold * 3 - preCash);
        draw = Math.max(0, draw);
        revolverDraw[i] = draw;
        revolverBal[i] += draw;
        preCash += draw;
      } else if (preCash > co.revolverDrawThreshold * 5 && revolverBal[i] > 0) {
        let repay = Math.min(revolverBal[i], preCash - co.revolverDrawThreshold * 3);
        repay = Math.max(0, repay);
        revolverRepay[i] = repay;
        revolverBal[i] -= repay;
        preCash -= repay;
      }
    }

    fcf[i] = cfo + cfi;
    cash[i] = preCash;
  }

  // Fundraising timeline
  let runwayMonths = null;
  let zeroMonth = null;
  for (let i = 1; i < MO; i++) {
    if (cash[i] <= 0 && zeroMonth === null) zeroMonth = i + 1;
  }
  if (zeroMonth) {
    runwayMonths = zeroMonth;
  } else {
    // project forward
    let lastBurn = (cash[MO-1] - cash[MO-2]);
    if (lastBurn < 0) runwayMonths = MO + Math.floor(cash[MO-1] / Math.abs(lastBurn));
    else runwayMonths = 999;
  }
  let suggestedRaiseMonth = runwayMonths !== 999 ? Math.max(1, runwayMonths - co.minCashRunway) : null;
  let monthlyBurnLast3 = (cash[MO-1] - cash[MO-4]) / 3;
  let avgBurn = monthlyBurnLast3 < 0 ? Math.abs(monthlyBurnLast3) : 0;
  let suggestedRaiseAmt = avgBurn > 0 ? avgBurn * co.targetRaiseMonths : 0;
  let impliedPreMoney = arr[MO-1] * co.arrMult;

  // Annuals
  let annFCF = [0,1,2].map(y => { let s=0; for(let m=y*12;m<(y+1)*12;m++) s+=fcf[m]; return s; });
  let annRev = [0,1,2].map(y => { let s=0; for(let m=y*12;m<(y+1)*12;m++) s+=rev[m]; return s; });
  let annEBITDA = [0,1,2].map(y => { let s=0; for(let m=y*12;m<(y+1)*12;m++) s+=ebitda[m]; return s; });
  let annNI = [0,1,2].map(y => { let s=0; for(let m=y*12;m<(y+1)*12;m++) s+=netInc[m]; return s; });

  // DCF
  let pvFCF = annFCF.map((f,i) => f / Math.pow(1+co.wacc, i+1));
  let sumPV = pvFCF.reduce((a,b) => a+b, 0);
  let tv = annFCF[2] > 0 ? annFCF[2]*(1+co.termGrowth)/(co.wacc-co.termGrowth) : 0;
  let pvTV = tv / Math.pow(1+co.wacc, 3);
  let dcfEV = sumPV + pvTV;
  let evARR = arr[MO-1] * co.arrMult;
  let evRev = annRev[2] * co.revMult;
  let avgEV = (dcfEV + evARR + evRev) / 3;

  // Monthly output
  let monthly = [];
  for (let i = 0; i < MO; i++) {
    let netNewARR = i === 0 ? 0 : arr[i] - arr[i-1];
    monthly.push({
      m: i+1, q: `Y${Math.floor(i/12)+1}Q${Math.floor((i%12)/3)+1}`,
      nc: Math.round(nc[i]), ac: Math.round(ac[i]), arpu: Math.round(arpu[i]),
      rev: Math.round(rev[i]), cogs: Math.round(cogs[i]), gp: Math.round(gp[i]),
      sm: Math.round(sm[i]), rd: Math.round(rd[i]), ga: Math.round(ga[i]),
      ebitda: Math.round(ebitda[i]), ebitdaM: rev[i]>0 ? +(ebitda[i]/rev[i]*100).toFixed(1) : 0,
      netInc: Math.round(netInc[i]), da: Math.round(da[i]),
      sMRR: Math.round(sMRR[i]), nMRR: Math.round(nMRR[i]), exMRR: Math.round(exMRR[i]),
      coMRR: Math.round(coMRR[i]), chMRR: Math.round(chMRR[i]), eMRR: Math.round(eMRR[i]),
      arr: Math.round(arr[i]),
      // WC
      ar: Math.round(arAcc[i]), apBal: Math.round(ap[i]), prepaid: Math.round(prepaid[i]),
      defRev: Math.round(defRev[i]), nwc: Math.round(nwc[i]), chNWC: Math.round(chNWC[i]),
      // Debt
      revolverBal: Math.round(revolverBal[i]), revolverDraw: Math.round(revolverDraw[i]),
      revolverRepay: Math.round(revolverRepay[i]),
      termDebtBal: Math.round(termDebtBal[i]), interestExp: Math.round(interestExp[i]),
      // Cash
      fcf: Math.round(fcf[i]), cash: Math.round(cash[i]),
      capex: Math.round(capex[i]), equityIn: Math.round(equityIn[i]),
      // VC metrics
      nrr: sMRR[i]>0 ? +((sMRR[i]-chMRR[i]-coMRR[i]+exMRR[i])/sMRR[i]*100).toFixed(1) : 0,
      magicN: sm[i]>0 ? +(netNewARR*4/sm[i]).toFixed(2) : 0,
      rule40: +(((i>0&&rev[i-1]>0?(rev[i]-rev[i-1])/rev[i-1]:0)*12 + (rev[i]>0?ebitda[i]/rev[i]:0))*100).toFixed(1),
      burnMult: netNewARR>0 ? +(Math.abs(Math.min(0,netInc[i]))/netNewARR).toFixed(2) : 0,
      ltv: mChurn>0 ? Math.round(arpu[i]*(1-co.cogsP)/mChurn) : 0,
      cac: nc[i]>0 ? Math.round(sm[i]/nc[i]) : 0,
      ltvCac: nc[i]>0&&sm[i]>0 ? +((mChurn>0?arpu[i]*(1-co.cogsP)/mChurn:0)/(sm[i]/nc[i])).toFixed(1) : 0,
      payback: nc[i]>0&&arpu[i]*(1-co.cogsP)>0 ? +((sm[i]/nc[i])/(arpu[i]*(1-co.cogsP))).toFixed(1) : 0,
      gpM: rev[i]>0 ? +((gp[i]/rev[i])*100).toFixed(1) : 0,
    });
  }

  return {
    monthly, annFCF, annRev, annEBITDA, annNI, pvFCF, sumPV, tv, pvTV, dcfEV, evARR, evRev, avgEV,
    mChurn, runwayMonths, suggestedRaiseMonth, suggestedRaiseAmt, impliedPreMoney, avgBurn, roundLog,
  };
}

/* ═══════════════════════════════════════════════════════════════
   FORMATTERS
   ═══════════════════════════════════════════════════════════════ */
const fmt = n => { if(n==null||isNaN(n)) return "—"; let a=Math.abs(n), s=n<0?"(":"", e=n<0?")":""; if(a>=1e9) return `${s}$${(a/1e9).toFixed(1)}B${e}`; if(a>=1e6) return `${s}$${(a/1e6).toFixed(1)}M${e}`; if(a>=1e3) return `${s}$${(a/1e3).toFixed(0)}K${e}`; return `${s}$${a.toFixed(0)}${e}`; };
const fN = n => { if(n==null||isNaN(n)) return "—"; if(Math.abs(n)>=1e6) return `${(n/1e6).toFixed(1)}M`; if(Math.abs(n)>=1e3) return `${(n/1e3).toFixed(0)}K`; return n.toFixed(0); };

/* ═══════════════════════════════════════════════════════════════
   UI COMPONENTS
   ═══════════════════════════════════════════════════════════════ */
const S = { display: "flex", alignItems: "center" };

const KPI = ({ label, val, sub, color, bench, small }) => (
  <div style={{ background: C.card, borderRadius: 10, padding: small ? "10px 12px" : "14px 16px", border: `1px solid ${C.border}`, position:"relative", overflow:"hidden", transition:"all .2s" }}
    onMouseEnter={e=>{e.currentTarget.style.borderColor=color||C.accent;e.currentTarget.style.transform="translateY(-1px)"}}
    onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;e.currentTarget.style.transform="none"}}>
    <div style={{position:"absolute",top:0,left:0,right:0,height:2,background:color||C.accent}} />
    <div style={{fontSize:10,color:C.textM,textTransform:"uppercase",letterSpacing:1.1,marginBottom:4,fontWeight:600}}>{label}</div>
    <div style={{fontSize:small?17:20,fontWeight:700,color:C.text,fontFamily:"'Fira Code',monospace"}}>{val}</div>
    {sub&&<div style={{fontSize:10,color:color||C.accent,marginTop:2,fontWeight:500}}>{sub}</div>}
    {bench&&<div style={{fontSize:9,color:C.textD,marginTop:2}}>{bench}</div>}
  </div>
);

const Card = ({ title, children, span=1, h }) => (
  <div style={{ background:C.card, borderRadius:10, padding:"14px 12px 8px", border:`1px solid ${C.border}`, gridColumn:`span ${span}`, minHeight:h||260 }}>
    {title&&<div style={{fontSize:10,fontWeight:700,color:C.textM,textTransform:"uppercase",letterSpacing:1.1,marginBottom:10,paddingLeft:2}}>{title}</div>}
    {children}
  </div>
);

const TT = ({active,payload,label,formatter}) => {
  if(!active||!payload?.length) return null;
  return (<div style={{background:"#141e35",border:`1px solid ${C.borderLight}`,borderRadius:8,padding:"7px 10px",fontSize:10,color:C.text}}>
    <div style={{fontWeight:700,marginBottom:3,color:C.accent}}>{label}</div>
    {payload.map((p,i)=>(<div key={i} style={{...S,gap:6,marginBottom:1}}><div style={{width:7,height:7,borderRadius:"50%",background:p.color}}/><span style={{color:C.textM}}>{p.name}:</span><span style={{fontWeight:600}}>{formatter?formatter(p.value):p.value}</span></div>))}
  </div>);
};

const InpField = ({label,val,onChange,type="number",step,suffix,tip,opts}) => {
  if(opts) return (<div style={{marginBottom:12}}>
    <label style={{fontSize:11,fontWeight:600,color:C.textM,display:"block",marginBottom:4,letterSpacing:.4}}>{label}</label>
    <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
      {opts.map(o=>(<button key={o.v} onClick={()=>onChange(o.v)} style={{padding:"7px 14px",borderRadius:6,border:`1.5px solid ${val===o.v?(o.c||C.accent):C.border}`,background:val===o.v?(o.c||C.accent)+"15":"transparent",color:val===o.v?(o.c||C.accent):C.textD,fontWeight:600,fontSize:11,cursor:"pointer",transition:"all .15s"}}>{o.l}</button>))}
    </div>
    {tip&&<div style={{fontSize:10,color:C.textD,marginTop:3,lineHeight:1.4}}>{tip}</div>}
  </div>);
  return (<div style={{marginBottom:12}}>
    <label style={{fontSize:11,fontWeight:600,color:C.textM,display:"block",marginBottom:4,letterSpacing:.4}}>{label}</label>
    <div style={{position:"relative"}}>
      <input type="number" step={step||1} value={val} onChange={e=>onChange(type==="pct"?parseFloat(e.target.value)/100||0:parseFloat(e.target.value)||0)}
        style={{width:"100%",padding:"8px 12px",borderRadius:7,border:`1px solid ${C.border}`,background:C.input,color:C.text,fontSize:13,fontFamily:"'Fira Code',monospace",outline:"none",boxSizing:"border-box",transition:"border .2s",paddingRight:suffix?32:12}}
        onFocus={e=>e.target.style.borderColor=C.accent} onBlur={e=>e.target.style.borderColor=C.border} />
      {suffix&&<span style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",color:C.textD,fontSize:11}}>{suffix}</span>}
    </div>
    {tip&&<div style={{fontSize:10,color:C.textD,marginTop:3,lineHeight:1.4}}>{tip}</div>}
  </div>);
};

const Section = ({title, children, icon}) => (
  <div style={{marginBottom:16}}>
    <div style={{...S,gap:8,marginBottom:10,paddingBottom:6,borderBottom:`1px solid ${C.border}`}}>
      <span style={{fontSize:15}}>{icon}</span>
      <span style={{fontSize:13,fontWeight:700,color:C.text,letterSpacing:.3}}>{title}</span>
    </div>
    {children}
  </div>
);

/* ═══════════════════════════════════════════════════════════════
   MAIN APP
   ═══════════════════════════════════════════════════════════════ */
const TABS = [
  {id:"overview",l:"Overview",ic:"◉"},
  {id:"mrr",l:"MRR/ARR",ic:"◈"},
  {id:"pnl",l:"P&L",ic:"▤"},
  {id:"wc",l:"Working Capital",ic:"⊞"},
  {id:"debt",l:"Debt & Equity",ic:"◆"},
  {id:"unit",l:"Unit Economics",ic:"◇"},
  {id:"vc",l:"VC Metrics",ic:"◎"},
  {id:"val",l:"Valuation",ic:"⊕"},
  {id:"raise",l:"Fundraising",ic:"🚀"},
];

export default function App() {
  const [portfolio, setPortfolio] = useState([defaultCo()]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [tab, setTab] = useState("overview");
  const [sideOpen, setSideOpen] = useState(true);
  const [anim, setAnim] = useState(true);
  const co = portfolio[activeIdx] || defaultCo();
  const upd = useCallback((k,v) => setPortfolio(p => { let n=[...p]; n[activeIdx]={...n[activeIdx],[k]:v}; return n; }), [activeIdx]);
  const model = useMemo(() => runModel(co), [co]);
  const d = model.monthly;
  const L = d[MO-1];
  const Q = d.filter((_,i)=>(i+1)%3===0);
  useEffect(()=>{setAnim(false);setTimeout(()=>setAnim(true),30)},[tab]);

  const addCo = () => { let n = defaultCo(); n.name = `Startup ${portfolio.length+1}`; setPortfolio(p=>[...p,n]); setActiveIdx(portfolio.length); };
  const delCo = i => { if(portfolio.length<=1) return; let n=portfolio.filter((_,j)=>j!==i); setPortfolio(n); setActiveIdx(Math.min(activeIdx,n.length-1)); };

  // Round management
  const addRound = () => upd("rounds", [...(co.rounds||[]), {month:24,amount:10000000,preMoneyMultiple:20,name:`Series ${String.fromCharCode(65+(co.rounds||[]).length)}`}]);
  const updRound = (i,k,v) => { let r=[...(co.rounds||[])]; r[i]={...r[i],[k]:v}; upd("rounds",r); };
  const delRound = i => upd("rounds", (co.rounds||[]).filter((_,j)=>j!==i));

  /* ─── ASSUMPTIONS PANEL ─── */
  const renderAssumptions = () => (
    <div style={{width:sideOpen?320:0,minWidth:sideOpen?320:0,background:C.card,borderRight:`1px solid ${C.border}`,overflow:"auto",transition:"all .3s",height:"100vh",position:"sticky",top:0}}>
      <div style={{padding:sideOpen?"14px 16px":"14px 4px",opacity:sideOpen?1:0,transition:"opacity .2s"}}>
        {/* Portfolio selector */}
        <div style={{marginBottom:14}}>
          <div style={{...S,justifyContent:"space-between",marginBottom:8}}>
            <span style={{fontSize:10,fontWeight:700,color:C.textM,textTransform:"uppercase",letterSpacing:1}}>Portfolio</span>
            <button onClick={addCo} style={{background:C.accent+"18",border:`1px solid ${C.accent}40`,borderRadius:5,color:C.accent,fontSize:11,fontWeight:700,padding:"3px 10px",cursor:"pointer"}}>+ Add</button>
          </div>
          <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
            {portfolio.map((c,i)=>(
              <div key={i} style={{...S,gap:4}}>
                <button onClick={()=>setActiveIdx(i)} style={{padding:"5px 10px",borderRadius:5,border:`1.5px solid ${i===activeIdx?C.accent:C.border}`,background:i===activeIdx?C.accent+"15":"transparent",color:i===activeIdx?C.accent:C.textD,fontSize:11,fontWeight:600,cursor:"pointer",maxWidth:100,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.name}</button>
                {portfolio.length>1&&i===activeIdx&&<button onClick={()=>delCo(i)} style={{background:"none",border:"none",color:C.danger,fontSize:13,cursor:"pointer",padding:0,lineHeight:1}}>×</button>}
              </div>
            ))}
          </div>
        </div>

        <InpField label="Company Name" val={co.name} onChange={v=>upd("name",v)} type="text" tip="Nome do startup no portfolio" />
        <div style={{marginBottom:12}}><input value={co.name} onChange={e=>upd("name",e.target.value)} style={{width:"100%",padding:"8px 12px",borderRadius:7,border:`1px solid ${C.border}`,background:C.input,color:C.text,fontSize:13,outline:"none",boxSizing:"border-box"}} /></div>

        <Section title="Customer Engine" icon="👥">
          <InpField label="Initial Customers" val={co.initialCust} onChange={v=>upd("initialCust",v)} tip="Current active customer base" />
          <InpField label="New Customers / Month" val={co.baseNewCust} onChange={v=>upd("baseNewCust",v)} tip="Month 1 new customer adds" />
          <InpField label="MoM Growth Rate" val={(co.custGrowth*100).toFixed(1)} onChange={v=>upd("custGrowth",v)} type="pct" step="0.1" suffix="%" tip="Monthly growth in acquisition. 3%=aggressive" />
          <InpField label="Retention Profile" val={co.retentionType} onChange={v=>upd("retentionType",v)}
            opts={[{v:"conservative",l:"Conservative",c:C.orange},{v:"standard",l:"Standard",c:C.cyan},{v:"aggressive",l:"Aggressive",c:C.green},{v:"custom",l:"Custom",c:C.purple}]}
            tip="Controls logo retention curve shape" />
          {co.retentionType==="custom"&&<>
            <InpField label="Retention @ M6" val={(co.customRetM6*100).toFixed(0)} onChange={v=>upd("customRetM6",v)} type="pct" step="1" suffix="%" />
            <InpField label="Retention @ M12" val={(co.customRetM12*100).toFixed(0)} onChange={v=>upd("customRetM12",v)} type="pct" step="1" suffix="%" />
            <InpField label="Retention @ M24" val={(co.customRetM24*100).toFixed(0)} onChange={v=>upd("customRetM24",v)} type="pct" step="1" suffix="%" />
            <InpField label="Retention @ M36" val={(co.customRetM36*100).toFixed(0)} onChange={v=>upd("customRetM36",v)} type="pct" step="1" suffix="%" />
          </>}
        </Section>

        <Section title="Revenue & Pricing" icon="💰">
          <InpField label="Base ARPU ($/mo)" val={co.baseARPU} onChange={v=>upd("baseARPU",v)} suffix="$" tip="Average revenue per user per month" />
          <InpField label="ARPU Growth (%/mo)" val={(co.arpuGrowth*100).toFixed(1)} onChange={v=>upd("arpuGrowth",v)} type="pct" step="0.1" suffix="%" tip="Price increases + upsell. 0.2%≈2.4%/yr" />
          <InpField label="Expansion MRR (%)" val={(co.expansionRate*100).toFixed(1)} onChange={v=>upd("expansionRate",v)} type="pct" step="0.1" suffix="%" tip="Monthly upsell/cross-sell rate" />
          <InpField label="Contraction MRR (%)" val={(co.contractionRate*100).toFixed(1)} onChange={v=>upd("contractionRate",v)} type="pct" step="0.1" suffix="%" tip="Monthly downgrade rate" />
        </Section>

        <Section title="Cost Structure" icon="📊">
          <InpField label="COGS (% Rev)" val={(co.cogsP*100).toFixed(0)} onChange={v=>upd("cogsP",v)} type="pct" step="1" suffix="%" tip="Hosting, support, infra. SaaS: 20-30%" />
          <InpField label="S&M (% Rev)" val={(co.smP*100).toFixed(0)} onChange={v=>upd("smP",v)} type="pct" step="1" suffix="%" tip="Sales & Marketing. Early: 30-50%" />
          <InpField label="R&D (% Rev)" val={(co.rdP*100).toFixed(0)} onChange={v=>upd("rdP",v)} type="pct" step="1" suffix="%" tip="Engineering & Product. 15-25%" />
          <InpField label="G&A (% Rev)" val={(co.gaP*100).toFixed(0)} onChange={v=>upd("gaP",v)} type="pct" step="1" suffix="%" tip="General & Admin. 8-15%" />
          <InpField label="D&A (% Rev)" val={(co.daP*100).toFixed(1)} onChange={v=>upd("daP",v)} type="pct" step="0.1" suffix="%" />
          <InpField label="Tax Rate" val={(co.taxRate*100).toFixed(0)} onChange={v=>upd("taxRate",v)} type="pct" step="1" suffix="%" />
        </Section>

        <Section title="Working Capital" icon="🔄">
          <InpField label="DSO (days)" val={co.dso} onChange={v=>upd("dso",v)} tip="Days Sales Outstanding. Typical: 30-60" />
          <InpField label="DPO (days)" val={co.dpo} onChange={v=>upd("dpo",v)} tip="Days Payable Outstanding. Typical: 30-45" />
          <InpField label="Prepaid Expenses (months)" val={co.prepaidMonths} onChange={v=>upd("prepaidMonths",v)} step="0.1" tip="Months of G&A prepaid" />
          <InpField label="Deferred Revenue (months)" val={co.deferredRevMonths} onChange={v=>upd("deferredRevMonths",v)} step="0.1" tip="Prepaid contract months. Annual=6" />
          <InpField label="CapEx (% Rev)" val={(co.capexP*100).toFixed(1)} onChange={v=>upd("capexP",v)} type="pct" step="0.1" suffix="%" />
          <InpField label="Starting Cash" val={co.startingCash} onChange={v=>upd("startingCash",v)} suffix="$" />
          <InpField label="Starting PP&E" val={co.startingPPE} onChange={v=>upd("startingPPE",v)} suffix="$" />
        </Section>

        <Section title="Revolving Credit Facility" icon="🏦">
          <InpField label="Enable Revolver" val={co.hasRevolver} onChange={v=>upd("hasRevolver",v)}
            opts={[{v:true,l:"Enabled",c:C.green},{v:false,l:"Disabled",c:C.textD}]} />
          {co.hasRevolver&&<>
            <InpField label="Revolver Limit" val={co.revolverLimit} onChange={v=>upd("revolverLimit",v)} suffix="$" tip="Maximum draw amount" />
            <InpField label="Interest Rate (%)" val={(co.revolverRate*100).toFixed(1)} onChange={v=>upd("revolverRate",v)} type="pct" step="0.1" suffix="%" />
            <InpField label="Draw Threshold" val={co.revolverDrawThreshold} onChange={v=>upd("revolverDrawThreshold",v)} suffix="$" tip="Draw when cash drops below this" />
          </>}
        </Section>

        <Section title="Term Debt" icon="📋">
          <InpField label="Enable Term Debt" val={co.hasTermDebt} onChange={v=>upd("hasTermDebt",v)}
            opts={[{v:true,l:"Enabled",c:C.green},{v:false,l:"Disabled",c:C.textD}]} />
          {co.hasTermDebt&&<>
            <InpField label="Principal Amount" val={co.termDebtAmount} onChange={v=>upd("termDebtAmount",v)} suffix="$" />
            <InpField label="Interest Rate (%)" val={(co.termDebtRate*100).toFixed(1)} onChange={v=>upd("termDebtRate",v)} type="pct" step="0.1" suffix="%" />
            <InpField label="Tenure (months)" val={co.termDebtTenure} onChange={v=>upd("termDebtTenure",v)} />
          </>}
        </Section>

        <Section title="Equity Rounds" icon="🎯">
          {(co.rounds||[]).map((r,i)=>(
            <div key={i} style={{background:C.card2,borderRadius:8,padding:"10px 12px",marginBottom:8,border:`1px solid ${C.border}`}}>
              <div style={{...S,justifyContent:"space-between",marginBottom:6}}>
                <input value={r.name} onChange={e=>updRound(i,"name",e.target.value)} style={{background:"none",border:"none",color:C.accent,fontWeight:700,fontSize:12,outline:"none",width:120}} />
                <button onClick={()=>delRound(i)} style={{background:"none",border:"none",color:C.danger,cursor:"pointer",fontSize:12}}>Remove</button>
              </div>
              <InpField label="Month" val={r.month} onChange={v=>updRound(i,"month",v)} tip="When the round closes" />
              <InpField label="Amount Raised ($)" val={r.amount} onChange={v=>updRound(i,"amount",v)} suffix="$" />
              <InpField label="Pre-Money Multiple (xARR)" val={r.preMoneyMultiple} onChange={v=>updRound(i,"preMoneyMultiple",v)} step="0.5" tip="Pre-money valuation as multiple of ARR at close" />
            </div>
          ))}
          <button onClick={addRound} style={{width:"100%",padding:"8px",borderRadius:6,border:`1px dashed ${C.border}`,background:"transparent",color:C.textM,fontSize:11,fontWeight:600,cursor:"pointer"}}>+ Add Round</button>
        </Section>

        <Section title="Valuation & Scenario" icon="⚡">
          <InpField label="WACC (%)" val={(co.wacc*100).toFixed(1)} onChange={v=>upd("wacc",v)} type="pct" step="0.5" suffix="%" tip="Early-stage: 15-25%" />
          <InpField label="Terminal Growth (%)" val={(co.termGrowth*100).toFixed(1)} onChange={v=>upd("termGrowth",v)} type="pct" step="0.5" suffix="%" />
          <InpField label="EV/ARR Multiple" val={co.arrMult} onChange={v=>upd("arrMult",v)} step="0.5" tip="Comparable SaaS. Top: 15-25x" />
          <InpField label="EV/Revenue Multiple" val={co.revMult} onChange={v=>upd("revMult",v)} step="0.5" />
          <InpField label="Scenario" val={co.scenario} onChange={v=>upd("scenario",v)}
            opts={[{v:1,l:"Bear",c:C.red},{v:2,l:"Base",c:C.cyan},{v:3,l:"Bull",c:C.green}]} tip="Adjusts growth, churn, S&M, expansion" />
          <InpField label="Min Cash Runway (months)" val={co.minCashRunway} onChange={v=>upd("minCashRunway",v)} tip="Minimum months of cash before raising" />
          <InpField label="Target Raise Runway (months)" val={co.targetRaiseMonths} onChange={v=>upd("targetRaiseMonths",v)} tip="How many months of runway to raise for" />
        </Section>
      </div>
    </div>
  );

  /* ─── DASHBOARD VIEWS ─── */
  const renderOverview = () => (
    <>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:10,marginBottom:16}}>
        <KPI label="ARR" val={fmt(L.arr)} sub={`MRR ${fmt(L.eMRR)}`} color={C.accent} small />
        <KPI label="Customers" val={fN(L.ac)} sub={`+${fN(L.nc)}/mo`} color={C.blue} small />
        <KPI label="NRR" val={`${L.nrr}%`} color={L.nrr>=120?C.green:L.nrr>=100?C.orange:C.red} bench=">120% best" small />
        <KPI label="LTV/CAC" val={`${L.ltvCac}x`} color={L.ltvCac>=3?C.green:C.orange} bench=">3.0x target" small />
        <KPI label="Magic #" val={L.magicN} color={L.magicN>=.75?C.green:C.orange} bench=">0.75" small />
        <KPI label="Rule of 40" val={`${L.rule40}%`} color={L.rule40>=40?C.green:C.orange} bench=">40%" small />
        <KPI label="Burn Multiple" val={`${L.burnMult}x`} color={L.burnMult<1.5?C.green:C.red} bench="<1.5x" small />
        <KPI label="Gross Margin" val={`${L.gpM}%`} color={L.gpM>=70?C.green:C.orange} bench=">70%" small />
        <KPI label="EBITDA Margin" val={`${L.ebitdaM}%`} color={L.ebitdaM>0?C.green:C.red} small />
        <KPI label="Cash" val={fmt(L.cash)} color={L.cash>0?C.accent:C.red} small />
        <KPI label="Runway" val={model.runwayMonths>=999?"∞":`${model.runwayMonths}mo`} color={model.runwayMonths>18?C.green:model.runwayMonths>12?C.orange:C.red} bench={model.suggestedRaiseMonth?`Raise by M${model.suggestedRaiseMonth}`:""} small />
        <KPI label="Avg EV" val={fmt(model.avgEV)} color={C.purple} sub="DCF + Multiples" small />
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
        <Card title="ARR Trajectory">
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={Q}><defs><linearGradient id="ga" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={C.accent} stopOpacity={.3}/><stop offset="95%" stopColor={C.accent} stopOpacity={0}/></linearGradient></defs>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border}/><XAxis dataKey="q" tick={{fill:C.textD,fontSize:9}}/><YAxis tick={{fill:C.textD,fontSize:9}} tickFormatter={v=>`${(v/1e6).toFixed(1)}M`}/>
              <Tooltip content={<TT formatter={fmt}/>}/><Area type="monotone" dataKey="arr" stroke={C.accent} fill="url(#ga)" strokeWidth={2} name="ARR"/>
              {model.roundLog.map((r,i)=><ReferenceLine key={i} x={Q.find(q2=>q2.m>=r.month)?.q} stroke={C.purple} strokeDasharray="4 4" label={{value:r.name,fill:C.purple,fontSize:9}}/>)}
            </AreaChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Cash Balance & Debt">
          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart data={Q}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border}/><XAxis dataKey="q" tick={{fill:C.textD,fontSize:9}}/><YAxis tick={{fill:C.textD,fontSize:9}} tickFormatter={v=>`${(v/1e6).toFixed(1)}M`}/>
              <Tooltip content={<TT formatter={fmt}/>}/>
              <Area type="monotone" dataKey="cash" stroke={C.accent} fill={C.accent+"20"} strokeWidth={2} name="Cash"/>
              <Line type="monotone" dataKey="revolverBal" stroke={C.orange} strokeWidth={1.5} strokeDasharray="4 4" name="Revolver" dot={false}/>
              <Line type="monotone" dataKey="termDebtBal" stroke={C.red} strokeWidth={1.5} strokeDasharray="4 4" name="Term Debt" dot={false}/>
              {model.roundLog.map((r,i)=><ReferenceLine key={i} x={Q.find(q2=>q2.m>=r.month)?.q} stroke={C.green} strokeDasharray="4 4"/>)}
            </ComposedChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Revenue & EBITDA" span={2}>
          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart data={Q}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border}/><XAxis dataKey="q" tick={{fill:C.textD,fontSize:9}}/><YAxis tick={{fill:C.textD,fontSize:9}} tickFormatter={v=>`${(v/1e3).toFixed(0)}K`}/>
              <Tooltip content={<TT formatter={fmt}/>}/><Legend wrapperStyle={{fontSize:9}}/>
              <Bar dataKey="rev" fill={C.cyan} name="Revenue" radius={[2,2,0,0]} barSize={16}/>
              <Line type="monotone" dataKey="ebitda" stroke={C.accent} strokeWidth={2} name="EBITDA" dot={false}/>
              <Line type="monotone" dataKey="netInc" stroke={C.orange} strokeWidth={1.5} name="Net Income" dot={false}/>
              <ReferenceLine y={0} stroke={C.textD} strokeDasharray="3 3"/>
            </ComposedChart>
          </ResponsiveContainer>
        </Card>
      </div>
    </>
  );

  const renderMRR = () => (
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      <Card title="MRR Bridge" span={2}>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={Q} stackOffset="sign"><CartesianGrid strokeDasharray="3 3" stroke={C.border}/><XAxis dataKey="q" tick={{fill:C.textD,fontSize:9}}/><YAxis tick={{fill:C.textD,fontSize:9}} tickFormatter={v=>`${(v/1e3).toFixed(0)}K`}/>
            <Tooltip content={<TT formatter={fmt}/>}/><Legend wrapperStyle={{fontSize:9}}/>
            <Bar dataKey="nMRR" stackId="p" fill={C.green} name="New" radius={[2,2,0,0]}/><Bar dataKey="exMRR" stackId="p" fill={C.cyan} name="Expansion"/>
            <Bar dataKey="coMRR" stackId="n" fill={C.orange} name="Contraction"/><Bar dataKey="chMRR" stackId="n" fill={C.red} name="Churn"/>
          </BarChart>
        </ResponsiveContainer>
      </Card>
      <Card title="Ending MRR"><ResponsiveContainer width="100%" height={200}><AreaChart data={Q}><defs><linearGradient id="gm" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={C.blue} stopOpacity={.3}/><stop offset="95%" stopColor={C.blue} stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" stroke={C.border}/><XAxis dataKey="q" tick={{fill:C.textD,fontSize:9}}/><YAxis tick={{fill:C.textD,fontSize:9}} tickFormatter={v=>`${(v/1e3).toFixed(0)}K`}/><Tooltip content={<TT formatter={fmt}/>}/><Area type="monotone" dataKey="eMRR" stroke={C.blue} fill="url(#gm)" strokeWidth={2} name="MRR"/></AreaChart></ResponsiveContainer></Card>
      <Card title="ARR"><ResponsiveContainer width="100%" height={200}><AreaChart data={Q}><defs><linearGradient id="ga2" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={C.accent} stopOpacity={.3}/><stop offset="95%" stopColor={C.accent} stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" stroke={C.border}/><XAxis dataKey="q" tick={{fill:C.textD,fontSize:9}}/><YAxis tick={{fill:C.textD,fontSize:9}} tickFormatter={v=>`${(v/1e6).toFixed(1)}M`}/><Tooltip content={<TT formatter={fmt}/>}/><Area type="monotone" dataKey="arr" stroke={C.accent} fill="url(#ga2)" strokeWidth={2} name="ARR"/></AreaChart></ResponsiveContainer></Card>
    </div>
  );

  const renderPnL = () => (
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      <div style={{gridColumn:"span 2",display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8}}>
        {[{l:"Y3 Revenue",v:fmt(model.annRev[2])},{l:"Y3 EBITDA",v:fmt(model.annEBITDA[2])},{l:"Y3 Net Income",v:fmt(model.annNI[2])},{l:"Gross Margin",v:`${L.gpM}%`},{l:"EBITDA Margin",v:`${L.ebitdaM}%`}].map((k,i)=><KPI key={i} label={k.l} val={k.v} small color={[C.cyan,C.accent,C.orange,C.green,C.blue][i]}/>)}
      </div>
      <Card title="Revenue / Gross Profit / EBITDA" span={2}>
        <ResponsiveContainer width="100%" height={250}><ComposedChart data={Q}><CartesianGrid strokeDasharray="3 3" stroke={C.border}/><XAxis dataKey="q" tick={{fill:C.textD,fontSize:9}}/><YAxis tick={{fill:C.textD,fontSize:9}} tickFormatter={v=>`${(v/1e3).toFixed(0)}K`}/><Tooltip content={<TT formatter={fmt}/>}/><Legend wrapperStyle={{fontSize:9}}/>
          <Bar dataKey="rev" fill={C.cyan} name="Revenue" radius={[2,2,0,0]} barSize={18}/><Bar dataKey="gp" fill={C.green} name="Gross Profit" radius={[2,2,0,0]} barSize={18}/>
          <Line type="monotone" dataKey="ebitda" stroke={C.accent} strokeWidth={2} name="EBITDA" dot={false}/><Line type="monotone" dataKey="netInc" stroke={C.orange} strokeWidth={2} name="Net Income" dot={false}/>
          <ReferenceLine y={0} stroke={C.textD} strokeDasharray="3 3"/>
        </ComposedChart></ResponsiveContainer>
      </Card>
      <Card title="Cost Breakdown (M36)">
        <ResponsiveContainer width="100%" height={220}><PieChart><Pie data={[{name:"COGS",value:L.cogs},{name:"S&M",value:L.sm},{name:"R&D",value:L.rd},{name:"G&A",value:L.ga}]} cx="50%" cy="50%" outerRadius={75} innerRadius={40} paddingAngle={3} dataKey="value" label={({name,percent})=>`${name} ${(percent*100).toFixed(0)}%`} style={{fontSize:10}}>
          <Cell fill={C.red}/><Cell fill={C.orange}/><Cell fill={C.blue}/><Cell fill={C.purple}/>
        </Pie><Tooltip formatter={v=>fmt(v)}/></PieChart></ResponsiveContainer>
      </Card>
      <Card title="EBITDA Margin Trend">
        <ResponsiveContainer width="100%" height={220}><AreaChart data={Q}><defs><linearGradient id="gem" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.green} stopOpacity={.25}/><stop offset="100%" stopColor={C.green} stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" stroke={C.border}/><XAxis dataKey="q" tick={{fill:C.textD,fontSize:9}}/><YAxis tick={{fill:C.textD,fontSize:9}} unit="%"/><Tooltip content={<TT formatter={v=>`${v}%`}/>}/><Area type="monotone" dataKey="ebitdaM" stroke={C.green} fill="url(#gem)" strokeWidth={2} name="EBITDA %"/><ReferenceLine y={0} stroke={C.textD} strokeDasharray="3 3"/></AreaChart></ResponsiveContainer>
      </Card>
    </div>
  );

  const renderWC = () => (
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      <div style={{gridColumn:"span 2",display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8}}>
        <KPI label="DSO" val={`${co.dso}d`} color={C.cyan} small /><KPI label="DPO" val={`${co.dpo}d`} color={C.green} small />
        <KPI label="AR (M36)" val={fmt(L.ar)} color={C.blue} small /><KPI label="AP (M36)" val={fmt(L.apBal)} color={C.orange} small />
        <KPI label="Net WC (M36)" val={fmt(L.nwc)} color={L.nwc>0?C.orange:C.green} small bench={L.nwc>0?"Cash tied up":"Cash source"} />
      </div>
      <Card title="Working Capital Components" span={2}>
        <ResponsiveContainer width="100%" height={250}><ComposedChart data={Q}><CartesianGrid strokeDasharray="3 3" stroke={C.border}/><XAxis dataKey="q" tick={{fill:C.textD,fontSize:9}}/><YAxis tick={{fill:C.textD,fontSize:9}} tickFormatter={v=>`${(v/1e3).toFixed(0)}K`}/><Tooltip content={<TT formatter={fmt}/>}/><Legend wrapperStyle={{fontSize:9}}/>
          <Bar dataKey="ar" fill={C.blue} name="Acc Receivable" barSize={14} radius={[2,2,0,0]}/><Bar dataKey="defRev" fill={C.green} name="Deferred Revenue" barSize={14} radius={[2,2,0,0]}/>
          <Bar dataKey="apBal" fill={C.orange} name="Acc Payable" barSize={14} radius={[2,2,0,0]}/><Line type="monotone" dataKey="nwc" stroke={C.red} strokeWidth={2} name="Net WC" dot={false}/>
        </ComposedChart></ResponsiveContainer>
      </Card>
      <Card title="Change in Net Working Capital" span={2}>
        <ResponsiveContainer width="100%" height={200}><BarChart data={Q}><CartesianGrid strokeDasharray="3 3" stroke={C.border}/><XAxis dataKey="q" tick={{fill:C.textD,fontSize:9}}/><YAxis tick={{fill:C.textD,fontSize:9}} tickFormatter={v=>`${(v/1e3).toFixed(0)}K`}/><Tooltip content={<TT formatter={fmt}/>}/>
          <Bar dataKey="chNWC" name="ΔWC" radius={[2,2,0,0]}>{Q.map((d2,i)=><Cell key={i} fill={d2.chNWC>0?C.red:C.green}/>)}</Bar>
          <ReferenceLine y={0} stroke={C.textD} strokeDasharray="3 3"/>
        </BarChart></ResponsiveContainer>
      </Card>
    </div>
  );

  const renderDebt = () => (
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      <div style={{gridColumn:"span 2",display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
        <KPI label="Revolver Balance" val={fmt(L.revolverBal)} color={L.revolverBal>0?C.orange:C.green} sub={co.hasRevolver?`Limit: ${fmt(co.revolverLimit)}`:"Disabled"} small />
        <KPI label="Term Debt Balance" val={fmt(L.termDebtBal)} color={L.termDebtBal>0?C.orange:C.green} sub={co.hasTermDebt?"Active":"Disabled"} small />
        <KPI label="Total Debt" val={fmt(L.revolverBal+L.termDebtBal)} color={C.orange} small />
        <KPI label="Total Interest (M36)" val={fmt(L.interestExp)} color={C.red} sub="Monthly interest cost" small />
      </div>
      <Card title="Debt Balances Over Time" span={2}>
        <ResponsiveContainer width="100%" height={240}><ComposedChart data={Q}><CartesianGrid strokeDasharray="3 3" stroke={C.border}/><XAxis dataKey="q" tick={{fill:C.textD,fontSize:9}}/><YAxis tick={{fill:C.textD,fontSize:9}} tickFormatter={v=>`${(v/1e3).toFixed(0)}K`}/><Tooltip content={<TT formatter={fmt}/>}/><Legend wrapperStyle={{fontSize:9}}/>
          <Area type="monotone" dataKey="revolverBal" stroke={C.orange} fill={C.orange+"20"} strokeWidth={2} name="Revolver"/>
          <Area type="monotone" dataKey="termDebtBal" stroke={C.red} fill={C.red+"15"} strokeWidth={2} name="Term Debt"/>
          <Line type="monotone" dataKey="cash" stroke={C.accent} strokeWidth={2} name="Cash" dot={false}/>
        </ComposedChart></ResponsiveContainer>
      </Card>
      <Card title="Equity Rounds" span={2} h={120}>
        <div style={{display:"grid",gridTemplateColumns:`repeat(${Math.max(1,(co.rounds||[]).length)},1fr)`,gap:10}}>
          {(model.roundLog||[]).map((r,i)=>(
            <div key={i} style={{background:C.card2,borderRadius:8,padding:12,border:`1px solid ${C.purple}30`}}>
              <div style={{fontSize:12,fontWeight:700,color:C.purple,marginBottom:6}}>{r.name} — Month {r.month}</div>
              <div style={{fontSize:11,color:C.textM,marginBottom:2}}>Raise: <span style={{color:C.text,fontWeight:600}}>{fmt(r.amount)}</span></div>
              <div style={{fontSize:11,color:C.textM,marginBottom:2}}>Pre-Money: <span style={{color:C.text,fontWeight:600}}>{fmt(r.preMoneyMultiple * (d[Math.min(r.month-1,MO-1)]?.arr||0))}</span></div>
              <div style={{fontSize:11,color:C.textM}}>Post-Money: <span style={{color:C.text,fontWeight:600}}>{fmt(r.postMoney)}</span></div>
              <div style={{fontSize:10,color:C.textD,marginTop:4}}>Dilution: {r.postMoney>0?((r.amount/r.postMoney)*100).toFixed(1):0}%</div>
            </div>
          ))}
          {(co.rounds||[]).length===0&&<div style={{color:C.textD,fontSize:12,padding:16,textAlign:"center"}}>No equity rounds configured. Add rounds in the assumptions panel.</div>}
        </div>
      </Card>
    </div>
  );

  const renderUnit = () => (
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      <div style={{gridColumn:"span 2",display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
        <KPI label="LTV" val={fmt(L.ltv)} color={C.green} small /><KPI label="CAC" val={fmt(L.cac)} color={C.orange} small />
        <KPI label="LTV/CAC" val={`${L.ltvCac}x`} color={L.ltvCac>=3?C.green:C.red} bench=">3.0x" small /><KPI label="Payback" val={`${L.payback}mo`} color={L.payback<=18?C.green:C.red} bench="<18mo" small />
      </div>
      <Card title="LTV vs CAC"><ResponsiveContainer width="100%" height={220}><ComposedChart data={Q}><CartesianGrid strokeDasharray="3 3" stroke={C.border}/><XAxis dataKey="q" tick={{fill:C.textD,fontSize:9}}/><YAxis tick={{fill:C.textD,fontSize:9}} tickFormatter={v=>`$${(v/1e3).toFixed(0)}K`}/><Tooltip content={<TT formatter={fmt}/>}/><Legend wrapperStyle={{fontSize:9}}/>
        <Bar dataKey="ltv" fill={C.green} name="LTV" barSize={16} radius={[2,2,0,0]}/><Bar dataKey="cac" fill={C.orange} name="CAC" barSize={16} radius={[2,2,0,0]}/>
      </ComposedChart></ResponsiveContainer></Card>
      <Card title="LTV/CAC & Payback"><ResponsiveContainer width="100%" height={220}><LineChart data={Q}><CartesianGrid strokeDasharray="3 3" stroke={C.border}/><XAxis dataKey="q" tick={{fill:C.textD,fontSize:9}}/><YAxis tick={{fill:C.textD,fontSize:9}}/><Tooltip content={<TT/>}/><Legend wrapperStyle={{fontSize:9}}/>
        <Line type="monotone" dataKey="ltvCac" stroke={C.green} strokeWidth={2} name="LTV/CAC" dot={false}/><Line type="monotone" dataKey="payback" stroke={C.blue} strokeWidth={2} name="Payback (mo)" dot={false}/>
        <ReferenceLine y={3} stroke={C.green} strokeDasharray="4 4" label={{value:"3.0x target",fill:C.green,fontSize:9}}/>
      </LineChart></ResponsiveContainer></Card>
    </div>
  );

  const renderVC = () => (
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      <Card title="VC Metrics Evolution" span={2}>
        <ResponsiveContainer width="100%" height={260}><LineChart data={Q}><CartesianGrid strokeDasharray="3 3" stroke={C.border}/><XAxis dataKey="q" tick={{fill:C.textD,fontSize:9}}/><YAxis tick={{fill:C.textD,fontSize:9}}/><Tooltip content={<TT/>}/><Legend wrapperStyle={{fontSize:9}}/>
          <Line type="monotone" dataKey="nrr" stroke={C.accent} strokeWidth={2} name="NRR %" dot={false}/><Line type="monotone" dataKey="ltvCac" stroke={C.green} strokeWidth={2} name="LTV/CAC" dot={false}/>
          <Line type="monotone" dataKey="rule40" stroke={C.blue} strokeWidth={2} name="Rule of 40" dot={false}/><Line type="monotone" dataKey="magicN" stroke={C.purple} strokeWidth={2} name="Magic #" dot={false}/>
          <ReferenceLine y={40} stroke={C.blue} strokeDasharray="4 4" label={{value:"Rule of 40",fill:C.blue,fontSize:8}}/><ReferenceLine y={120} stroke={C.accent} strokeDasharray="4 4" label={{value:"120% NRR",fill:C.accent,fontSize:8}}/>
        </LineChart></ResponsiveContainer>
      </Card>
      <Card title="Burn Multiple"><ResponsiveContainer width="100%" height={200}><AreaChart data={Q}><defs><linearGradient id="gbm" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.orange} stopOpacity={.25}/><stop offset="100%" stopColor={C.orange} stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" stroke={C.border}/><XAxis dataKey="q" tick={{fill:C.textD,fontSize:9}}/><YAxis tick={{fill:C.textD,fontSize:9}}/><Tooltip content={<TT/>}/><Area type="monotone" dataKey="burnMult" stroke={C.orange} fill="url(#gbm)" strokeWidth={2} name="Burn Multiple"/><ReferenceLine y={1.5} stroke={C.red} strokeDasharray="4 4" label={{value:"1.5x threshold",fill:C.red,fontSize:8}}/></AreaChart></ResponsiveContainer></Card>
      <Card title="NRR"><ResponsiveContainer width="100%" height={200}><AreaChart data={Q}><defs><linearGradient id="gnrr" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.accent} stopOpacity={.25}/><stop offset="100%" stopColor={C.accent} stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" stroke={C.border}/><XAxis dataKey="q" tick={{fill:C.textD,fontSize:9}}/><YAxis tick={{fill:C.textD,fontSize:9}} unit="%" domain={['dataMin-5','dataMax+5']}/><Tooltip content={<TT formatter={v=>`${v}%`}/>}/><Area type="monotone" dataKey="nrr" stroke={C.accent} fill="url(#gnrr)" strokeWidth={2} name="NRR"/><ReferenceLine y={100} stroke={C.textD} strokeDasharray="3 3"/></AreaChart></ResponsiveContainer></Card>
    </div>
  );

  const renderVal = () => (
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      <div style={{gridColumn:"span 2",display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
        <KPI label="DCF EV" val={fmt(model.dcfEV)} color={C.cyan} small /><KPI label="EV/ARR" val={fmt(model.evARR)} sub={`${co.arrMult}x`} color={C.blue} small />
        <KPI label="EV/Rev" val={fmt(model.evRev)} sub={`${co.revMult}x`} color={C.green} small /><KPI label="Blended EV" val={fmt(model.avgEV)} color={C.purple} small />
      </div>
      <Card title="Valuation Comparison">
        <ResponsiveContainer width="100%" height={220}><BarChart data={[{n:"DCF",v:model.dcfEV},{n:"EV/ARR",v:model.evARR},{n:"EV/Rev",v:model.evRev},{n:"Average",v:model.avgEV}]} layout="vertical">
          <CartesianGrid strokeDasharray="3 3" stroke={C.border}/><XAxis type="number" tick={{fill:C.textD,fontSize:9}} tickFormatter={v=>`${(v/1e6).toFixed(0)}M`}/><YAxis type="category" dataKey="n" tick={{fill:C.text,fontSize:10,fontWeight:600}} width={55}/>
          <Tooltip content={<TT formatter={fmt}/>}/><Bar dataKey="v" name="EV" radius={[0,5,5,0]} barSize={24}><Cell fill={C.cyan}/><Cell fill={C.blue}/><Cell fill={C.green}/><Cell fill={C.purple}/></Bar>
        </BarChart></ResponsiveContainer>
      </Card>
      <Card title="DCF Components">
        <div style={{padding:"6px 4px"}}>
          {[{l:"PV Y1 FCF",v:model.pvFCF[0],c:C.cyan},{l:"PV Y2 FCF",v:model.pvFCF[1],c:C.blue},{l:"PV Y3 FCF",v:model.pvFCF[2],c:C.green},{l:"PV Terminal Value",v:model.pvTV,c:C.purple},{l:"Enterprise Value",v:model.dcfEV,c:C.accent}].map((r,i)=>(
            <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:i<4?`1px solid ${C.border}`:"none"}}>
              <div style={{...S,gap:6}}><div style={{width:8,height:8,borderRadius:"50%",background:r.c}}/><span style={{color:C.textM,fontSize:11}}>{r.l}</span></div>
              <span style={{color:C.text,fontWeight:i===4?700:500,fontFamily:"'Fira Code',monospace",fontSize:12}}>{fmt(r.v)}</span>
            </div>
          ))}
          <div style={{marginTop:8,padding:"8px 10px",background:C.card2,borderRadius:6,fontSize:10,color:C.textD}}>WACC {(co.wacc*100).toFixed(1)}% · g {(co.termGrowth*100).toFixed(1)}% · TV/EV {model.dcfEV!==0?((model.pvTV/model.dcfEV)*100).toFixed(0):0}%</div>
        </div>
      </Card>
    </div>
  );

  const renderRaise = () => {
    let rm = model.runwayMonths;
    let srm = model.suggestedRaiseMonth;
    let sra = model.suggestedRaiseAmt;
    let ipre = model.impliedPreMoney;
    let cashData = d.map(m=>({m:m.m, cash:m.cash, q:m.q}));
    let projectedZero = rm < 999 ? rm : null;

    return (
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
        {/* Fundraising Alert */}
        <div style={{gridColumn:"span 2",background: rm<=12?C.red+"15":rm<=18?C.orange+"15":C.green+"12",border:`1px solid ${rm<=12?C.red:rm<=18?C.orange:C.green}40`,borderRadius:10,padding:"16px 20px"}}>
          <div style={{...S,gap:10,marginBottom:8}}>
            <span style={{fontSize:22}}>{rm<=12?"🚨":rm<=18?"⚠️":"✅"}</span>
            <div>
              <div style={{fontSize:14,fontWeight:700,color:C.text}}>{rm>=999?"No fundraise needed in forecast period":rm<=12?"CRITICAL: Runway under 12 months":`Runway: ${rm} months`}</div>
              <div style={{fontSize:11,color:C.textM,marginTop:2}}>
                {srm?`Recommended to begin fundraising by Month ${srm} (${co.minCashRunway}-month buffer)`:"Cash flow positive — fundraising is strategic, not survival"}
              </div>
            </div>
          </div>
        </div>

        <div style={{gridColumn:"span 2",display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8}}>
          <KPI label="Cash Runway" val={rm>=999?"∞":`${rm} months`} color={rm>18?C.green:rm>12?C.orange:C.red} small />
          <KPI label="Monthly Burn (avg)" val={model.avgBurn>0?fmt(model.avgBurn):"FCF+"} color={model.avgBurn>0?C.orange:C.green} small />
          <KPI label="Suggested Raise" val={sra>0?fmt(sra):"—"} sub={`${co.targetRaiseMonths}mo runway`} color={C.blue} small />
          <KPI label="Implied Pre-Money" val={fmt(ipre)} sub={`${co.arrMult}x ARR`} color={C.purple} small />
          <KPI label="Implied Dilution" val={sra>0&&ipre>0?`${((sra/(ipre+sra))*100).toFixed(1)}%`:"—"} color={C.orange} small />
        </div>

        <Card title="Cash Trajectory & Fundraising Windows" span={2}>
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={Q}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border}/><XAxis dataKey="q" tick={{fill:C.textD,fontSize:9}}/><YAxis tick={{fill:C.textD,fontSize:9}} tickFormatter={v=>`${(v/1e6).toFixed(1)}M`}/>
              <Tooltip content={<TT formatter={fmt}/>}/><Legend wrapperStyle={{fontSize:9}}/>
              <Area type="monotone" dataKey="cash" stroke={C.accent} fill={C.accent+"18"} strokeWidth={2} name="Cash Balance"/>
              <ReferenceLine y={0} stroke={C.red} strokeWidth={2} label={{value:"Zero Cash",fill:C.red,fontSize:9}}/>
              {model.roundLog.map((r,i)=><ReferenceLine key={i} x={Q.find(q2=>q2.m>=r.month)?.q} stroke={C.green} strokeDasharray="4 4" label={{value:`${r.name}: ${fmt(r.amount)}`,fill:C.green,fontSize:9}}/>)}
              {srm&&<ReferenceLine x={Q.find(q2=>q2.m>=srm)?.q} stroke={C.orange} strokeDasharray="6 3" label={{value:`Begin raise`,fill:C.orange,fontSize:9}}/>}
            </ComposedChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Fundraising Scenarios" span={2} h={160}>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
            {[
              {l:"Conservative",mult:10,c:C.orange},
              {l:"Market",mult:co.arrMult,c:C.cyan},
              {l:"Premium",mult:co.arrMult*1.5,c:C.green},
            ].map((sc,i)=>{
              let pre2 = L.arr * sc.mult;
              let raise2 = sra>0?sra:co.targetRaiseMonths*model.avgBurn;
              let post2 = pre2 + Math.max(0,raise2);
              let dil = post2>0?Math.max(0,raise2)/post2*100:0;
              return (
                <div key={i} style={{background:C.card2,borderRadius:8,padding:14,border:`1px solid ${sc.c}25`}}>
                  <div style={{fontSize:12,fontWeight:700,color:sc.c,marginBottom:8}}>{sc.l} ({sc.mult}x ARR)</div>
                  <div style={{fontSize:11,color:C.textM,marginBottom:3}}>Pre-Money: <span style={{color:C.text,fontWeight:600,fontFamily:"'Fira Code',monospace"}}>{fmt(pre2)}</span></div>
                  <div style={{fontSize:11,color:C.textM,marginBottom:3}}>Raise: <span style={{color:C.text,fontWeight:600,fontFamily:"'Fira Code',monospace"}}>{fmt(Math.max(0,raise2))}</span></div>
                  <div style={{fontSize:11,color:C.textM,marginBottom:3}}>Post-Money: <span style={{color:C.text,fontWeight:600,fontFamily:"'Fira Code',monospace"}}>{fmt(post2)}</span></div>
                  <div style={{fontSize:11,color:C.textM}}>Dilution: <span style={{color:dil>25?C.red:C.green,fontWeight:700}}>{dil.toFixed(1)}%</span></div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    );
  };

  const views = {overview:renderOverview,mrr:renderMRR,pnl:renderPnL,wc:renderWC,debt:renderDebt,unit:renderUnit,vc:renderVC,val:renderVal,raise:renderRaise};

  return (
    <div style={{display:"flex",minHeight:"100vh",background:C.bg,color:C.text,fontFamily:"'DM Sans',system-ui,sans-serif"}}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=Fira+Code:wght@400;500;600;700&display=swap" rel="stylesheet"/>
      {renderAssumptions()}
      <div style={{flex:1,minWidth:0}}>
        {/* Header */}
        <div style={{background:C.card,borderBottom:`1px solid ${C.border}`,padding:"8px 16px",...S,justifyContent:"space-between",position:"sticky",top:0,zIndex:100}}>
          <div style={{...S,gap:10}}>
            <button onClick={()=>setSideOpen(!sideOpen)} style={{background:"none",border:`1px solid ${C.border}`,borderRadius:5,color:C.textM,padding:"4px 8px",cursor:"pointer",fontSize:12}}>{sideOpen?"◂":"▸"}</button>
            <span style={{fontSize:15,fontWeight:800,background:G1,WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>{co.name}</span>
            <span style={{fontSize:9,padding:"2px 8px",borderRadius:4,background:co.scenario===1?C.red+"20":co.scenario===3?C.green+"20":C.cyan+"20",color:co.scenario===1?C.red:co.scenario===3?C.green:C.cyan,fontWeight:700}}>{co.scenario===1?"BEAR":co.scenario===3?"BULL":"BASE"}</span>
          </div>
          <div style={{...S,gap:8}}>
            <span style={{fontSize:10,color:C.textD}}>M36 ARR: <span style={{color:C.accent,fontWeight:700}}>{fmt(L.arr)}</span></span>
            <span style={{fontSize:10,color:C.textD}}>|</span>
            <span style={{fontSize:10,color:C.textD}}>EV: <span style={{color:C.purple,fontWeight:700}}>{fmt(model.avgEV)}</span></span>
          </div>
        </div>
        {/* Tabs */}
        <div style={{display:"flex",gap:1,padding:"6px 12px",background:C.card,borderBottom:`1px solid ${C.border}`,overflowX:"auto"}}>
          {TABS.map(t=>(
            <button key={t.id} onClick={()=>setTab(t.id)} style={{padding:"6px 12px",borderRadius:5,border:"none",cursor:"pointer",background:tab===t.id?C.accent+"18":"transparent",color:tab===t.id?C.accent:C.textD,fontWeight:tab===t.id?700:500,fontSize:11,transition:"all .15s",whiteSpace:"nowrap",...S,gap:4}}>
              <span style={{fontSize:10}}>{t.ic}</span>{t.l}
            </button>
          ))}
        </div>
        {/* Content */}
        <div style={{padding:16,maxWidth:1100,opacity:anim?1:0,transform:anim?"translateY(0)":"translateY(6px)",transition:"all .25s ease"}}>
          {views[tab]?.()}
        </div>
      </div>
    </div>
  );
}
