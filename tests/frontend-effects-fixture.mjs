export const source = `export default function Screen(){return <main id="effects">
<section id="gradient">Native gradient <span>Editable label</span></section>
<p id="wrapped">An editable paragraph whose actual browser line breaks must survive the conversion.</p>
<section id="pattern">Original background image</section>
<section id="radial">Radial decoration</section>
<div id="overlap"><span id="above">Above</span><span id="below">Below</span></div>
<div id="rotated">Transformed component</div>
<svg id="complex-svg" width="70" height="40"><defs><filter id="blur"><feGaussianBlur stdDeviation="2"/></filter></defs><rect x="10" y="10" width="40" height="20" fill="#2563eb" filter="url(#blur)"/></svg>
<input id="field" defaultValue="Agent canvas"/><div id="blurred">Native blur</div>
</main>}`;
export const css = `@font-face{font-family:Fixture;src:url('/fixture.ttf');font-weight:400}
*{box-sizing:border-box;font-family:Fixture}body{margin:0}#effects{width:400px;padding:16px;background:#fff;color:#172554;font-size:15px;line-height:20px}
section{height:56px;padding:10px;margin-bottom:10px;border-radius:8px}
#gradient{background:linear-gradient(120deg,#2563eb 0%,#16a34a 50%,#f59e0b 100%);color:white}#gradient span{display:block}
#wrapped{width:190px;margin:0 0 10px;text-align:right}#pattern{position:relative;background:#f1f5f9 url('/badge.svg') right center/32px 32px no-repeat}
#pattern::before{content:'+';position:absolute;right:40px;top:10px;color:#2563eb;font-size:22px}
#radial{background:radial-gradient(ellipse at center,#fde68a,#60a5fa)}
#overlap{position:relative;height:40px;margin-bottom:16px}#overlap span{position:absolute;padding:8px}#above{z-index:3;background:#ef4444;color:white;left:10px}#below{z-index:1;background:#22c55e;left:40px}
#rotated{width:220px;height:30px;background:#dbeafe;transform:rotate(7deg);filter:contrast(1.1);margin:0 0 18px 8px;padding:5px}
#field{display:block;width:220px;height:32px;margin-bottom:10px;border:1px solid #94a3b8;border-radius:5px;padding:5px;color:#172554;background:#fff}
#blurred{background:#dbeafe;height:32px;padding:5px;filter:blur(.5px)}`;
