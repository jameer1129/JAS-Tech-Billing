/* JAS Tech — shared invoice engine. Used by index.html and invoice.html. */
(function(){
  'use strict';

  const A4_WIDTH=794,A4_HEIGHT=1123;
  let CONFIG=null,html2pdfLoadPromise=null;

  /* ---- Images are embedded as data URLs while the PDF is built ----
     The PDF builder (html2canvas) re-requests every <img> from the server.
     With data URLs there is nothing to request, so it works from the
     service-worker cache and never depends on the network. */
  const assetDataUrls={};
  function assetSrc(path){return assetDataUrls[path]||path;}
  function blobToDataUrl(blob){
    return new Promise((resolve,reject)=>{
      const reader=new FileReader();
      reader.onload=()=>resolve(reader.result);
      reader.onerror=()=>reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }
  async function loadAssetAsDataUrl(path){
    if(assetDataUrls[path])return true;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
    try{
      const res=await fetch(new URL(path,location.href).href,{signal:controller.signal});
      if(!res.ok)return false;
      const blob=await res.blob();
      if(!blob.size||!/^image\//i.test(blob.type))return false;
      assetDataUrls[path]=await blobToDataUrl(blob);
      return true;
    }catch(e){
      return false;
    }finally{
      clearTimeout(timer);
    }
  }
  function neededAssetPaths(data){
    const d=normalizeData(data),c=CONFIG||{},a=c.assets||{},list=[];
    if(a.horizontalLogo)list.push(a.horizontalLogo);
    if(d.showWatermark&&c.display?.showWatermark!==false&&a.watermark)list.push(a.watermark);
    if(c.display?.showQr!==false&&d.showQr&&a.scannerQr)list.push(a.scannerQr);
    if(c.display?.showSignature!==false&&d.showSignature&&a.signature)list.push(a.signature);
    return [...new Set(list)];
  }
  /* Loads every image the invoice needs. Returns the list of paths that
     could NOT be loaded (empty array = all good). */
  async function preloadAssets(data){
    const paths=neededAssetPaths(data);
    const results=await Promise.all(paths.map(loadAssetAsDataUrl));
    return paths.filter((_,i)=>!results[i]);
  }

  function configure(config){
    CONFIG=config||{};
    /* Invoice colour is fixed to the LIGHT theme colour, so dark mode or
       the page it is generated from never changes the invoice. */
    try{document.documentElement.style.setProperty('--inv-primary',(CONFIG.theme&&CONFIG.theme.light&&CONFIG.theme.light.primary)||'#012587');}catch(e){}
    return CONFIG;
  }
  /* One date style everywhere: DD-MM-YYYY (accepts YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY). */
  function formatInvoiceDate(v){
    const s=String(v==null?'':v).trim();
    if(!s)return '';
    let m=s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if(m)return m[3]+'-'+m[2]+'-'+m[1];
    m=s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
    if(m)return m[1].padStart(2,'0')+'-'+m[2].padStart(2,'0')+'-'+m[3];
    return s;
  }
  function roundMoney(n){return Math.round((Number(n)||0)*100)/100;}
  function escapeHtml(str){
    if(str==null||str==='')return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
  }
  function formatCurrency(amount,includeSymbol=true){
    const symbol=includeSymbol?((CONFIG&&CONFIG.invoice&&CONFIG.invoice.currencySymbol)||'₹'):'';
    return symbol+' '+(Number(amount)||0).toLocaleString('en-IN',{maximumFractionDigits:2,minimumFractionDigits:2});
  }
  function formatServiceLabel(text){
    const words=String(text||'').split(' ');
    return words.length>1?escapeHtml(words[0])+'<br>'+escapeHtml(words.slice(1).join(' ')):escapeHtml(text);
  }
  function normalizeData(data){
    const d=data||{};
    return {
      invoiceNumber:d.invoiceNumber||'AUTO',
      dateStr:formatInvoiceDate(d.dateStr),
      customer:{name:d.customer?.name||'',address:d.customer?.address||'',mobile:d.customer?.mobile||''},
      products:Array.isArray(d.products)?d.products:[],
      notes:d.notes==null?null:String(d.notes),
      includeNotesOnPdf:d.includeNotesOnPdf!==false,
      showWatermark:d.showWatermark!==false,
      showQr:d.showQr!==false,
      showSignature:d.showSignature!==false
    };
  }
  function calculateTotals(products){
    let totalItems=products.length,totalQty=0,grandTotal=0;
    for(const p of products){
      totalQty+=Number(p.qty)||0;
      grandTotal+=roundMoney((Number(p.qty)||0)*(Number(p.rate)||0));
    }
    return {totalItems,totalQty,grandTotal:roundMoney(grandTotal)};
  }
  function buildProductMetaHtml(p){
    const bits=[];
    if(p.description)bits.push(`<div class="prod-desc-line">${escapeHtml(p.description)}</div>`);
    if(p.serial)bits.push(`<div class="prod-sn-line"><span class="sn-label">S/N:</span> <span class="sn-value">${escapeHtml(p.serial)}</span></div>`);
    return bits.length?`<div class="prod-meta">${bits.join('')}</div>`:'';
  }
  function buildInvRowHtml(p,idx){
    return `<tr><td class="idx">${idx}.</td><td><div class="prod-name">${escapeHtml(p.name)}</div>${buildProductMetaHtml(p)}</td><td class="num" style="text-align:center;font-weight:500;">${escapeHtml(p.qty)}</td><td class="num">${formatCurrency(p.rate,false)}</td><td class="num">${formatCurrency(roundMoney((Number(p.qty)||0)*(Number(p.rate)||0)),false)}</td></tr>`;
  }
  function measureBlocks(blocksObj){
    const temp=document.createElement('div');
    temp.style.cssText='position:absolute;left:-9999px;top:0;width:704px;visibility:hidden;';
    document.body.appendChild(temp);
    const wrappers={};
    for(const key in blocksObj){
      const w=document.createElement('div');
      w.innerHTML=blocksObj[key];
      temp.appendChild(w);
      wrappers[key]=w;
    }
    const heights={};
    for(const key in wrappers)heights[key]=wrappers[key].getBoundingClientRect().height;
    temp.remove();
    return heights;
  }
  function measureTableParts(products){
    const temp=document.createElement('div');
    temp.style.cssText='position:absolute;left:-9999px;top:0;width:704px;visibility:hidden;';
    document.body.appendChild(temp);
    temp.innerHTML=`<table class="inv-table"><thead><tr><th class="idx">#</th><th>PRODUCT / DESCRIPTION</th><th class="col-qty">QTY</th><th class="col-rate num">RATE (₹)</th><th class="col-amt num">AMOUNT (₹)</th></tr></thead><tbody>${products.map((p,i)=>buildInvRowHtml(p,i+1)).join('')}</tbody></table>`;
    const theadHeight=temp.querySelector('thead').getBoundingClientRect().height;
    const rowHeights=Array.from(temp.querySelectorAll('tbody tr')).map(r=>r.getBoundingClientRect().height);
    temp.remove();
    return {theadHeight,rowHeights};
  }

  function renderInvoiceTemplate(data,targetContainerId='invoiceRoot'){
    const root=document.getElementById(targetContainerId);
    if(!root)throw new Error('Invoice render target not found.');
    const d=normalizeData(data),c=CONFIG||{};
    const {totalItems,totalQty,grandTotal}=calculateTotals(d.products);

    const page1HeaderHtml=`<div class="inv-header"><img src="${escapeHtml(assetSrc(c.assets?.horizontalLogo||''))}" class="inv-header__logo" crossOrigin="anonymous" alt="${escapeHtml(c.company?.name||'')}"><div class="inv-header__right"><div class="inv-header__ribbon"><span class="inv-header__ribbon-text">INVOICE</span><span class="inv-header__ribbon-stripe"></span><span class="inv-header__ribbon-stripe"></span></div><div class="inv-header__meta"><div class="row"><span class="k">Invoice No.</span><span class="sep">:</span><span class="v">${escapeHtml(d.invoiceNumber)}</span></div><div class="row"><span class="k">Date</span><span class="sep">:</span><span class="v">${escapeHtml(d.dateStr)}</span></div></div></div></div><hr class="inv-divider"><div class="inv-customer"><div class="inv-customer__icon"><i class="fa-solid fa-user"></i></div><div class="inv-customer__details"><div class="inv-customer__label">BILL TO</div><div class="inv-customer__name">${escapeHtml(d.customer.name)}</div>${d.customer.address?`<div class="inv-customer__address">${escapeHtml(d.customer.address)}</div>`:''}${d.customer.mobile?`<div class="inv-customer__line">Mobile: ${escapeHtml(d.customer.mobile)}</div>`:''}</div></div>`;

    const qrVisible=c.display?.showQr!==false&&d.showQr;
    const signatureVisible=c.display?.showSignature!==false&&d.showSignature;

    const footerHtml=`<div class="inv-footer"><div class="inv-footer-details"><div class="contact-block"><div><i class="fa-solid fa-location-dot"></i> <span>${(c.company?.addressLines||[]).map(escapeHtml).join('<br>')}</span></div><div><i class="fa-solid fa-phone"></i> <span>${escapeHtml(c.company?.phone||'')}</span></div><div><i class="fa-solid fa-envelope"></i> <span>${escapeHtml(c.company?.email||'')}</span></div></div>${qrVisible?`<div class="qr-block"><img src="${escapeHtml(assetSrc(c.assets?.scannerQr||''))}" crossOrigin="anonymous" alt="QR Code"><span>${escapeHtml(c.scanner?.scannerCaption||'')}</span></div>`:''}${signatureVisible?`<div class="sign-block"><div class="for-line">${escapeHtml(c.signatureBlock?.forLine||'')}</div><img src="${escapeHtml(assetSrc(c.assets?.signature||''))}" crossOrigin="anonymous" alt="Signature"><div class="auth-line">${escapeHtml(c.signatureBlock?.authLine||'')}</div></div>`:''}</div><div class="inv-services">${(c.services||[]).map((s,i)=>`${i>0?'<span class="inv-services__sep"></span>':''}<div class="inv-services__item"><i class="fa-solid ${escapeHtml(s.icon)}"></i> <div>${formatServiceLabel(s.label)}</div></div>`).join('')}</div><div class="inv-thanks-container"><div class="inv-thanks-line left"></div><div class="inv-thanks">${escapeHtml(c.footer?.thankYouMessage||'')}</div><div class="inv-thanks-line right"></div></div><div class="inv-copy">${escapeHtml(c.footer?.copyrightLine||'')}</div></div>`;

    const notesText=d.notes===null?(c.invoice?.defaultNotes||''):String(d.notes||'').trim();
    const showNotes=c.display?.showNotes!==false&&notesText&&d.includeNotesOnPdf;
    const notesHtml=showNotes?`<div class="inv-notes"><div class="inv-notes__label"><i class="fa-solid fa-clipboard-list" style="font-size:16px"></i> NOTES</div><div class="inv-notes__text">${escapeHtml(notesText)}</div></div>`:'';

    const summaryHtml=`<div class="inv-summary">${c.display?.showTotalItems?`<div class="inv-summary__row"><span>TOTAL ITEMS</span><b>${totalItems}</b></div>`:''}${c.display?.showTotalQuantity?`<div class="inv-summary__row"><span>TOTAL QUANTITY</span><b>${totalQty}</b></div>`:''}<div class="inv-summary__total"><span class="label" style="font-size:16px;">GRAND TOTAL</span><span class="value">${formatCurrency(grandTotal,true)}</span></div></div>`;

    const watermarkHtml=d.showWatermark&&c.display?.showWatermark!==false?`<img src="${escapeHtml(assetSrc(c.assets?.watermark||''))}" class="inv-watermark" crossOrigin="anonymous" alt="Watermark Background">`:'';

    const PAGE_HEIGHT=A4_HEIGHT,PAGE_PAD_TOP=40,PAGE_PAD_BOTTOM=30,TABLE_MARGIN_TOP=12,TABLE_BORDER=2,SAFETY_MARGIN=10;
    const products=d.products,chunks=[];

    if(!products.length){
      chunks.push({isLast:true,products:[],rowsHeight:0});
    }else{
      const contPageHeaderSample=`<div class="page-continuation-header"><div class="cont-left"><img src="${escapeHtml(assetSrc(c.assets?.horizontalLogo||''))}" class="cont-logo" alt=""><div class="inv-header__ribbon" style="margin-bottom:0;padding:3px 45px 3px 25px;font-size:14px;"><span class="inv-header__ribbon-text">INVOICE</span></div><span class="cont-page-count">(Page 1 of 1)</span></div><div class="cont-inv-no">No. ${escapeHtml(d.invoiceNumber)}</div></div>`;
      const bottomRowHtml=`<div class="inv-bottom-row">${showNotes?notesHtml:''}${summaryHtml}</div>`;
      const blockHeights=measureBlocks({page1Header:page1HeaderHtml,contHeader:contPageHeaderSample,bottomRow:bottomRowHtml,footer:footerHtml});
      const page1HeaderHeight=blockHeights.page1Header;
      const contHeaderHeight=blockHeights.contHeader;
      const bottomExtra=blockHeights.bottomRow+blockHeights.footer+TABLE_MARGIN_TOP;
      const {theadHeight,rowHeights}=measureTableParts(products);

      const page1Budget=PAGE_HEIGHT-PAGE_PAD_TOP-PAGE_PAD_BOTTOM-page1HeaderHeight-TABLE_MARGIN_TOP-theadHeight-TABLE_BORDER-SAFETY_MARGIN;
      const contBudget=PAGE_HEIGHT-PAGE_PAD_TOP-PAGE_PAD_BOTTOM-contHeaderHeight-TABLE_MARGIN_TOP-theadHeight-TABLE_BORDER-SAFETY_MARGIN;

      let i=0;
      while(i<products.length){
        const isFirstPage=chunks.length===0,budget=isFirstPage?page1Budget:contBudget;
        let sum=0,j=i;
        while(j<products.length){
          if(sum+rowHeights[j]>budget&&j>i)break;
          sum+=rowHeights[j];
          j++;
        }
        chunks.push({isLast:false,products:products.slice(i,j),rowsHeight:sum});
        i=j;
      }

      if(!chunks.length)chunks.push({isLast:false,products:[],rowsHeight:0});

      const last=chunks[chunks.length-1],budgetForLast=chunks.length===1?page1Budget:contBudget;
      if(last.rowsHeight+bottomExtra<=budgetForLast)last.isLast=true;
      else chunks.push({isLast:true,products:[],rowsHeight:0});
    }

    const totalPages=chunks.length;
    let pagesHtml='',globalIdx=1;

    chunks.forEach((chunk,pageIndex)=>{
      const isFirstPage=pageIndex===0,isLastPage=chunk.isLast,pageNum=pageIndex+1;
      const rowsHtml=chunk.products.map(p=>buildInvRowHtml(p,globalIdx++)).join('');
      const contPageHeaderHtml=`<div class="page-continuation-header"><div class="cont-left"><img src="${escapeHtml(assetSrc(c.assets?.horizontalLogo||''))}" class="cont-logo" crossOrigin="anonymous" alt="${escapeHtml(c.company?.name||'')}"><span class="cont-page-count">(Page ${pageNum} of ${totalPages})</span></div><div class="cont-inv-no"><div class="inv-header__ribbon" style="margin-bottom:0;padding:3px 45px 3px 25px;font-size:14px;"><span class="inv-header__ribbon-text">INVOICE</span><span class="inv-header__ribbon-stripe"></span><span class="inv-header__ribbon-stripe"></span></div>No. ${escapeHtml(d.invoiceNumber)}</div></div>`;
      const tableHtml=chunk.products.length?`<table class="inv-table"><thead><tr><th class="idx">#</th><th>PRODUCT / DESCRIPTION</th><th class="col-qty">QTY</th><th class="col-rate num">RATE (₹)</th><th class="col-amt num">AMOUNT (₹)</th></tr></thead><tbody>${rowsHtml}</tbody></table>`:'';

      pagesHtml+=`<div class="invoice-page ${isFirstPage?'':'page-continuation'}">${isFirstPage?page1HeaderHtml:contPageHeaderHtml}<div class="inv-table-wrap">${tableHtml}</div>${isLastPage?`<div class="inv-bottom-row">${showNotes?notesHtml:''}${summaryHtml}</div>${footerHtml}`:''}${watermarkHtml}</div>`;
    });

    root.innerHTML=pagesHtml;
    return root;
  }

  function fitInvoiceToSinglePage(targetContainerId='invoiceRoot'){
    const root=document.getElementById(targetContainerId);
    if(!root)return;
    root.querySelectorAll('.invoice-page').forEach(page=>{
      page.classList.remove('compact','compact-2');
      if(page.scrollHeight>A4_HEIGHT)page.classList.add('compact');
      if(page.scrollHeight>A4_HEIGHT)page.classList.add('compact-2');
    });
  }

  function waitForImages(root){
    const imgs=Array.from(root.querySelectorAll('img'));
    return Promise.all(imgs.map(async img=>{
      try{
        if(!img.complete)await new Promise((res,rej)=>{img.onload=res;img.onerror=rej;});
        if(typeof img.decode==='function')await img.decode();
      }catch(e){console.warn('Asset load bypassed:',img.src);}
    }));
  }

  function loadHtml2Pdf(){
    if(window.html2pdf)return Promise.resolve(window.html2pdf);
    if(html2pdfLoadPromise)return html2pdfLoadPromise;
    html2pdfLoadPromise=new Promise((resolve,reject)=>{
      const script=document.createElement('script');
      script.src='https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
      script.onload=()=>resolve(window.html2pdf);
      script.onerror=e=>{html2pdfLoadPromise=null;reject(e);};
      document.head.appendChild(script);
    });
    return html2pdfLoadPromise;
  }

  /* ---- Shared PDF helpers (used by index.html AND invoice.html) ---- */

  /* Creates the off-screen render area if the page does not have it. */
  function ensureRenderTarget(rootId,wrapperId){
    let root=document.getElementById(rootId),wrapper=document.getElementById(wrapperId);
    if(root&&wrapper)return;
    let host=document.getElementById('pdfRenderWrap');
    if(!host){host=document.createElement('div');host.id='pdfRenderWrap';document.body.appendChild(host);}
    if(!wrapper){wrapper=document.createElement('div');wrapper.id=wrapperId;wrapper.className='pdf-wrapper-container';host.appendChild(wrapper);}
    if(!root){root=document.createElement('div');root.id=rootId;root.className='invoice-render';wrapper.appendChild(root);}
  }

  /* One check for everything an invoice needs: the stylesheet + every image.
     Returns the list of missing things (empty array = all good). */
  async function checkAssets(data){
    const missing=[];
    const cssLink=document.querySelector('link[rel="stylesheet"][href*="invoice-engine.css"]');
    if(!cssLink||!cssLink.sheet)missing.push('invoice-engine.css');
    try{missing.push(...await preloadAssets(data));}
    catch(e){console.warn('Invoice asset check failed:',e);missing.push('(asset check error)');}
    return missing;
  }

  /* Starts the html2pdf download during idle time so the first PDF is fast.
     Skipped on data-saver / very slow connections. */
  function warmup(){
    if(window.html2pdf||html2pdfLoadPromise)return;
    const conn=navigator.connection||navigator.mozConnection||navigator.webkitConnection;
    if(conn){
      if(conn.saveData)return;
      if(conn.effectiveType&&['slow-2g','2g'].includes(conn.effectiveType))return;
    }
    const schedule=typeof window.requestIdleCallback==='function'
      ?cb=>window.requestIdleCallback(cb,{timeout:4000})
      :cb=>setTimeout(cb,2000);
    schedule(()=>{loadHtml2Pdf().catch(()=>{});});
  }

  /* Saves a blob as a file (same behaviour for employee and customer). */
  function downloadBlob(blob,filename){
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;a.download=filename;a.style.display='none';
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),3000);
  }

  async function buildPdfBlob(data,targetContainerId,wrapperId){
    const root=document.getElementById(targetContainerId),wrapper=document.getElementById(wrapperId);
    if(!root||!wrapper)throw new Error('Invoice PDF render target not found.');

    const missingAssets=await checkAssets(data);
    if(missingAssets.length)throw new Error('Invoice images could not be loaded: '+missingAssets.join(', '));

    renderInvoiceTemplate(data,targetContainerId);
    await waitForImages(root);
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    fitInvoiceToSinglePage(targetContainerId);
    void wrapper.offsetHeight;

    // The invoice stylesheet is read once (from the service-worker cache) and
    // injected into html2canvas's page copy as a <style> tag, so the copy does
    // not request invoice-engine.css from the server again.
    const cssLink=document.querySelector('link[rel="stylesheet"][href*="invoice-engine.css"]');
    let inlineCss='';
    if(cssLink){
      try{
        const cssRes=await fetch(cssLink.href);
        if(cssRes.ok)inlineCss=await cssRes.text();
      }catch(e){inlineCss='';}
    }

    const invoiceNumber=normalizeData(data).invoiceNumber;
    const opt={
      margin:0,
      filename:`${CONFIG.invoice?.filePrefix||'JAS_Invoice_'}${invoiceNumber}.pdf`,
      image:{type:'jpeg',quality:0.95},
      html2canvas:{
        scale:3,
        useCORS:true,
        allowTaint:true,
        backgroundColor:'#FFFFFF',
        logging:false,
        width:A4_WIDTH,
        windowWidth:A4_WIDTH,
        scrollX:0,
        scrollY:0,
        x:0,
        y:0,
        // html2canvas clones the whole page; skip the app's own <img> tags
        // (logos in the loader / app bar) so it does not request them again.
        ignoreElements:(el)=>{
          if(inlineCss&&el.tagName==='LINK'&&cssLink&&el.href===cssLink.href)return true;
          return el.tagName==='IMG'&&!/^data:/i.test(el.getAttribute('src')||'')&&!el.closest('#'+wrapperId+', .html2pdf__container');
        },
        onclone:(clonedDoc)=>{
          if(!inlineCss)return;
          const style=clonedDoc.createElement('style');
          style.textContent=inlineCss;
          clonedDoc.head.appendChild(style);
        }
      },
      jsPDF:{unit:'px',format:[A4_WIDTH,A4_HEIGHT],orientation:'portrait'},
      pagebreak:{mode:['css','legacy']}
    };

    const html2pdfFn=await loadHtml2Pdf();
    const blob=await html2pdfFn().set(opt).from(wrapper).outputPdf('blob');
    return {blob,filename:opt.filename};
  }

  /* The ONE function both pages call to make the invoice PDF. */
  async function generatePdfBlob(data,targetContainerId='invoiceRoot',wrapperId='pdfWrapper'){
    ensureRenderTarget(targetContainerId,wrapperId);
    try{
      return await buildPdfBlob(data,targetContainerId,wrapperId);
    }finally{
      const r=document.getElementById(targetContainerId);
      if(r)r.innerHTML='';
    }
  }

  window.InvoiceEngine={
    configure,
    preloadAssets,
    checkAssets,
    loadHtml2Pdf,
    warmup,
    downloadBlob,
    renderInvoiceTemplate,
    generatePdfBlob,
    fitInvoiceToSinglePage,
    formatCurrency,
    escapeHtml,
    normalizeData,
    formatInvoiceDate,
    A4_WIDTH,
    A4_HEIGHT
  };
})();