import {FACETS,effectiveTags,generalSafe,generalApproved,applyPending,searchRows,canReviewCatalog} from "./policy.js";
import {REASONS,qualityLabel,learningPriority,learningSummary} from "./feedback.js";

const $ = function(id) {return document.getElementById(id);};
const state = {config:null,token:null,refreshToken:null,expires:0,account:null,manifest:null,records:[],pending:[],selected:new Set(),client:null,generalOnly:false,view:"browse",demo:false,active:null,blobs:new Map(),access:new Map(),generation:0,bulk:[],visibleLimit:48};
function element(tag,className,text) {const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}
function notice(message,error=false) {$("notice").textContent=message;$("notice").classList.toggle("hidden",!message);$("notice").classList.toggle("error",error);}
function key(record) {const value=record.file_key || String(record.file_id).replace(/^id:/,"");if(!/^[A-Za-z0-9_-]+$/.test(value))throw new Error("Invalid file identifier.");return value;}
function child(path) {if(path.startsWith("/") || path.split("/").some(function(p){return p===".." || p==="." || p.includes("\\");}))throw new Error("Unsafe catalog path.");return state.config.catalogRoot.replace(/\/$/,"")+"/"+path;}
function ascii(value) {return JSON.stringify(value).replace(/[\u007f-\uffff]/g,function(c){return "\\u"+c.charCodeAt(0).toString(16).padStart(4,"0");});}
async function api(endpoint,args,rooted=true) {
  await tokenReady();
  const headers={Authorization:"Bearer "+state.token,"Content-Type":"application/json"};
  if(rooted)headers["Dropbox-API-Path-Root"]=JSON.stringify({".tag":"namespace_id",namespace_id:state.config.namespaceId});
  for(let attempt=0;attempt<3;attempt++) {
    const response=await fetch("https://api.dropboxapi.com/2/"+endpoint,{method:"POST",headers:headers,body:JSON.stringify(args),signal:AbortSignal.timeout(30000)});
    if(response.status===429 && attempt<2){await new Promise(function(resolve){setTimeout(resolve,Math.min(Number(response.headers.get("Retry-After") || 2),20)*1000);});continue;}
    if(!response.ok){const body=await response.json().catch(function(){return {};});throw new Error("Dropbox: "+(body.error_summary || "request could not be completed"));}
    return response.json();
  }
}
async function download(path,asBlob=false) {
  await tokenReady();
  const response=await fetch("https://content.dropboxapi.com/2/files/download",{method:"POST",headers:{Authorization:"Bearer "+state.token,"Dropbox-API-Path-Root":JSON.stringify({".tag":"namespace_id",namespace_id:state.config.namespaceId}),"Dropbox-API-Arg":ascii({path:child(path)})},signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error("Catalog file is unavailable. Confirm Dropbox setup and refresh.");
  return asBlob ? response.blob() : response.json();
}
async function tokenReady() {
  if(!state.token)throw new Error("Connect your Dropbox account first.");
  if(Date.now()<state.expires-60000)return;
  if(!state.refreshToken)throw new Error("Your Dropbox session expired. Connect again.");
  await exchange({grant_type:"refresh_token",refresh_token:state.refreshToken,client_id:state.config.appKey});
}
async function exchange(values) {
  const response=await fetch("https://api.dropboxapi.com/oauth2/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams(values),signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error("Dropbox sign-in could not be completed. Try connecting again.");
  const token=await response.json();
  state.token=token.access_token;state.refreshToken=token.refresh_token || state.refreshToken;state.expires=Date.now()+(token.expires_in || 14400)*1000;
}
function randomString(bytes=48) {const values=new Uint8Array(bytes);crypto.getRandomValues(values);return btoa(String.fromCharCode(...values)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");}
async function connect() {
  if(!state.config?.appKey){notice("The catalog’s Dropbox connection is waiting for owner-approved setup. You can explore the demo in the meantime.");return;}
  const verifier=randomString(64), nonce=randomString(32);
  const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier));
  const challenge=btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
  const redirect=state.config.redirectUri || location.origin+location.pathname;
  sessionStorage.setItem("broll-pkce",JSON.stringify({verifier:verifier,state:nonce,redirect:redirect,created:Date.now()}));
  const params=new URLSearchParams({client_id:state.config.appKey,response_type:"code",code_challenge_method:"S256",code_challenge:challenge,state:nonce,redirect_uri:redirect,token_access_type:"offline",scope:"account_info.read files.metadata.read files.content.read files.content.write"});
  location.assign("https://www.dropbox.com/oauth2/authorize?"+params);
}
async function callback() {
  const params=new URLSearchParams(location.search);
  if(!params.has("code") && !params.has("error"))return false;
  const saved=JSON.parse(sessionStorage.getItem("broll-pkce") || "null");
  sessionStorage.removeItem("broll-pkce");
  history.replaceState({},document.title,location.pathname);
  if(params.has("error"))throw new Error("Dropbox sign-in was cancelled.");
  if(!saved || saved.state!==params.get("state") || Date.now()-saved.created>600000)throw new Error("Sign-in expired or could not be verified. Connect Dropbox again.");
  await exchange({grant_type:"authorization_code",code:params.get("code"),code_verifier:saved.verifier,client_id:state.config.appKey,redirect_uri:saved.redirect});
  state.account=await api("users/get_current_account",null,false);
  await loadCatalog();
  return true;
}
async function pool(items,limit,operation) {
  let index=0;const result=new Array(items.length);
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async function(){
    while(index<items.length){const current=index++;result[current]=await operation(items[current]);}
  }));
  return result;
}
function canReview() {return state.demo || canReviewCatalog(state.manifest,state.account,state.catalogMetadata);}
async function accessible(record) {
  if(state.demo)return true;
  const cacheKey=record.file_id+":"+record.rev;
  const saved=state.access.get(cacheKey);
  if(saved && Date.now()-saved.at<60000)return saved.allowed;
  let allowed=false;
  try{const meta=await api("files/get_metadata",{path:record.file_id});allowed=!record.rev || meta.rev===record.rev;}catch(error){allowed=false;}
  state.access.set(cacheKey,{allowed:allowed,at:Date.now()});
  return allowed;
}
async function ownPending() {
  state.pending=[];
  const reviewer=String(state.account.account_id).replace(/[^A-Za-z0-9_-]/g,"_");
  let entries=[],cursor=null,more=true;
  try {
    while(more) {
      const value=cursor ? await api("files/list_folder/continue",{cursor:cursor}) : await api("files/list_folder",{path:child("decisions/"+reviewer),recursive:false,limit:2000});
      entries.push(...value.entries);cursor=value.cursor;more=value.has_more;
    }
  } catch(error) {if(!String(error.message).includes("not_found"))throw error;return;}
  const recent=entries.filter(function(entry){return entry[".tag"]==="file" && entry.name.endsWith(".json") && entry.server_modified>state.manifest.generated_at;}).sort(function(a,b){return a.server_modified.localeCompare(b.server_modified);});
  const events=await pool(recent,5,async function(entry){
    const relative=entry.path_display.slice(state.config.catalogRoot.length).replace(/^\//,"");
    const value=await download(relative);
    if(value.reviewer_account_id!==state.account.account_id || value.actor_kind!=="human")return null;
    return {...value,event_id:entry.id+":"+entry.rev};
  });
  state.pending=events.filter(Boolean);
}
async function loadCatalog() {
  notice("Opening your Dropbox catalog…");
  state.demo=false;
  $("demo-banner").classList.add("hidden");
  const manifest=await download("catalog/manifest.json");
  state.manifest=manifest;
  state.catalogMetadata=await api("files/get_metadata",{path:state.config.catalogRoot}).catch(function(){return null;});
  const allowed=await pool(manifest.clients,4,async function(client){
    try{await api("files/get_metadata",{path:client.path});return client;}catch(error){return null;}
  });
  const clients=allowed.filter(Boolean);
  if(!clients.length)throw new Error("Your Dropbox account cannot open any configured client footage folders.");
  state.allowedClients=clients;
  state.client=clients.some(function(c){return c.slug===state.client;})?state.client:(clients.find(function(c){return c.slug===state.config.defaultClient;}) || clients[0]).slug;
  const docs=await pool(clients,4,async function(client){return download("catalog/"+client.slug+".json");});
  const general=await download("catalog/general.json");
  state.processingStatus=await download("status.json").catch(function(){return null;});
  if([...docs,general].some(function(doc){return doc.generated_at!==manifest.generated_at;}))throw new Error("The processor is publishing a new catalog. Refresh in a moment.");
  const unique=new Map();
  [...docs,general].forEach(function(doc){doc.records.forEach(function(record){unique.set(record.file_id,record);});});
  state.records=[...unique.values()];
  await ownPending();
  setAccount();
  buildClients();
  $("connect").classList.add("hidden");
  $("signout").classList.remove("hidden");
  $("connection-status").textContent="Connected to Dropbox";
  $("updated").textContent="Catalog updated "+new Date(manifest.generated_at).toLocaleString();
  notice(canReview()?"":"You can browse the library. A configured reviewer account is needed to approve footage.");
  await render();
}
function setAccount() {
  $("account-name").textContent=state.demo?"Demo editor":state.account?.name?.display_name || "Dropbox editor";
  $("account-role").textContent=canReview()?"Editor · reviewer":"Editor · read only";
  $("account-avatar").textContent=state.demo?"DE":(state.account?.name?.display_name || "DB").split(" ").map(function(x){return x[0];}).slice(0,2).join("");
}
function buildClients() {
  $("clients").replaceChildren();
  (state.allowedClients || []).forEach(function(client){
    const button=element("button","client-button"+(client.slug===state.client && !state.generalOnly?" active":""));
    button.append(element("span","client-badge",client.name.split(" ").map(function(x){return x[0];}).slice(0,2).join("")),element("span","",client.name));
    button.addEventListener("click",function(){state.client=client.slug;state.generalOnly=false;state.visibleLimit=48;$("review-batch").value="";buildClients();render();});
    $("clients").append(button);
  });
  $("general-pool").classList.toggle("active",state.generalOnly);
}
function rowsWithPending() {return state.records.map(function(record){return applyPending(record,state.pending);});}
function formatDuration(value) {const seconds=Math.floor(value || 0);return Math.floor(seconds/60)+":"+String(seconds%60).padStart(2,"0");}
function title(record) {return (record.ai?.description || record.name).split(/[.!?]/)[0];}
function demoPoster(index) {
  const colors=[["#8d9d83","#a7b4a0","#d4c7a1"],["#51656a","#819b94","#b4cbb7"],["#927c5b","#bbb086","#e0c890"],["#5b7187","#8f9eaa","#c5d5df"],["#4f7166","#91ad96","#e1d6b0"],["#806e5c","#aa9877","#c8b394"]][index%6];
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450"><rect width="800" height="450" fill="'+colors[1]+'"/><circle cx="'+(540-index*22%250)+'" cy="96" r="48" fill="'+colors[2]+'" opacity=".75"/><path d="M0 290 150 190 340 300 530 155 800 280V450H0Z" fill="'+colors[0]+'"/><path d="M0 340 220 265 390 345 580 250 800 355V450H0Z" fill="#253b34" opacity=".6"/><path d="M0 405 220 355 380 410 800 348V450H0Z" fill="#142d2d" opacity=".6"/><text x="25" y="425" font-family="Arial" font-size="15" letter-spacing="3" fill="#ffffffaa">SYNTHETIC PREVIEW</text></svg>';
  return URL.createObjectURL(new Blob([svg],{type:"image/svg+xml"}));
}
async function imageUrl(record,sheet=false) {
  const cacheKey=key(record)+":"+(sheet?"sheet":"thumb");
  if(state.blobs.has(cacheKey))return state.blobs.get(cacheKey);
  const url=state.demo?demoPoster(record.demo_index || 0):URL.createObjectURL(await download((sheet?"sheets/":"thumbs/")+key(record)+".jpg",true));
  state.blobs.set(cacheKey,url);return url;
}
function makeCard(record) {
  const card=element("article","clip-card"+(state.selected.has(record.file_id)?" selected":""));
  card.tabIndex=0;
  const preview=element("div","clip-image");
  const image=element("img");image.alt=title(record);image.loading="lazy";
  if(record.pipeline_status==="analyzed"){
    imageUrl(record).then(function(url){image.src=url;}).catch(function(){image.replaceWith(element("div","clip-image-placeholder","Preview unavailable"));});
    preview.append(image);
    preview.addEventListener("mouseenter",function(){imageUrl(record,true).then(function(url){image.src=url;image.classList.add("sheet-hover");}).catch(function(){});});
    preview.addEventListener("mouseleave",function(){imageUrl(record).then(function(url){image.src=url;image.classList.remove("sheet-hover");}).catch(function(){});});
  }else preview.append(element("div","clip-image-placeholder","Waiting for analysis"));
  const tier=record.human?.status==="approved"?record.human.tier:(record.human?.status==="rejected"?"rejected":record.pipeline_status==="analyzed"?"needs review":"queued");
  preview.append(element("span","tier "+(["hero","solid","filler"].includes(tier)?tier:"pending"),tier.toUpperCase()),element("span","clip-duration",record.technical?formatDuration(record.technical.duration):"—"));
  const selection=element("input","clip-selection");selection.type="checkbox";selection.checked=state.selected.has(record.file_id);selection.setAttribute("aria-label","Add "+record.name+" to pull list");selection.disabled=record.human?.status!=="approved";
  selection.addEventListener("click",function(event){event.stopPropagation();});
  selection.addEventListener("change",function(){toggleSelection(record);card.classList.toggle("selected",state.selected.has(record.file_id));});
  preview.append(selection);
  const info=element("div","clip-info");info.append(element("h3","",title(record)));
  const meta=element("div","clip-meta");
  const technical=record.technical || {};
  meta.append(element("span","",(Math.max(technical.width || 0,technical.height || 0)>=3840?"4K":technical.width?"HD":"SOURCE")+" · "+(technical.orientation==="v"?"Portrait":"Landscape")+(technical.fps?" · "+technical.fps+" fps":"")));
  meta.append(element("span",generalApproved(record)?"general-mark":"",generalApproved(record)?"◎ General use":record.client));
  const tags=element("div","clip-tags");Object.values(effectiveTags(record)).flat().filter(function(tag){return !["none","unknown"].includes(tag);}).slice(0,3).forEach(function(tag){tags.append(element("span","clip-tag",tag));});
  if(record.usage?.length)tags.append(element("span","clip-tag","Used "+record.usage.length+"×"));
  info.append(meta,tags);
  if(state.view==="review"){
    info.append(element("p","suggestion-label "+(record.quality?.decision || "pending"),qualityLabel(record)));
    if(record.quality?.reason)info.append(element("p","suggestion-reason",record.quality.reason));
  }
  card.append(preview,info);
  card.addEventListener("click",function(){openDetail(record);});
  card.addEventListener("keydown",function(event){if(event.key==="Enter"){event.preventDefault();openDetail(record);}});
  return card;
}
function updateSelected() {
  $("stat-selected").textContent=state.selected.size;$("selected-count").textContent=state.selected.size;$("pull-list").disabled=!state.selected.size;
}
function toggleSelection(record) {if(record.human?.status!=="approved")return;if(state.selected.has(record.file_id))state.selected.delete(record.file_id);else state.selected.add(record.file_id);updateSelected();}
async function render() {
  const generation=++state.generation;
  document.querySelectorAll("[data-view]").forEach(function(button){button.classList.toggle("active",button.dataset.view===state.view);});
  $("review-batches").classList.toggle("hidden",state.view!=="review");
  $("learning-panel").classList.toggle("hidden",state.view!=="review");
  $("activity").classList.toggle("hidden",state.view!=="activity");$("browse-controls").classList.toggle("hidden",state.view==="activity");$("results").classList.toggle("hidden",state.view==="activity");
  const all=rowsWithPending();
  const own=all.filter(function(record){return state.generalOnly?generalApproved(record):record.client_slug===state.client;});
  $("stat-approved").textContent=own.filter(function(r){return r.human?.status==="approved";}).length;
  $("stat-review").textContent=own.filter(function(r){return r.human?.status==="needs_review" && r.pipeline_status==="analyzed";}).length;
  $("stat-general").textContent=all.filter(generalApproved).length;
  $("review-count").textContent=own.filter(function(r){return r.human?.status==="needs_review" && r.pipeline_status==="analyzed";}).length;
  const client=(state.allowedClients || []).find(function(c){return c.slug===state.client;});
  $("learning-summary").textContent=learningSummary(client?.feedback,state.pending.filter(function(e){return all.some(function(r){return r.file_id===e.file_id && r.client_slug===state.client;});}).length);
  const label=state.generalOnly?"General-use pool":client?.name || "Footage";
  $("breadcrumb-client").textContent=label;
  $("page-title").textContent=state.view==="review"?"Make the good shots easy to find.":state.view==="activity"?"The library, in motion.":label;
  $("page-description").textContent=state.view==="review"?"Confirm quality, check publication concerns, and clear footage for the next edit.":state.view==="activity"?"Review decisions, processing, and where your footage has been used.":"Approved B-roll for this client, with cleared general-use footage alongside it.";
  $("page-eyebrow").textContent=state.view==="review"?"REVIEW QUEUE":state.view==="activity"?"WORKSPACE ACTIVITY":"YOUR FOOTAGE, READY TO FIND";
  if(state.view==="activity"){renderActivity(all);$("empty").classList.add("hidden");$("load-more").classList.add("hidden");return;}
  if(state.view==="review"){
    const selectedBatch=$("review-batch").value,counts=new Map();
    own.filter(function(r){return r.pipeline_status==="analyzed" && ($("review-status-filter").value==="all" || r.human?.status===$("review-status-filter").value);}).forEach(function(r){const project=r.project || "Unassigned shoot";counts.set(project,(counts.get(project) || 0)+1);});
    $("review-batch").replaceChildren(element("option","","All shoots"));$("review-batch").firstChild.value="";
    [...counts].sort().forEach(function(entry){const option=element("option","",entry[0].split("/").filter(Boolean).slice(-1)[0]+" · "+entry[1]+" files");option.value=entry[0];$("review-batch").append(option);});
    if(counts.has(selectedBatch))$("review-batch").value=selectedBatch;
  }
  const filters={tier:$("filter-tier").value,shot:$("filter-shot").value,movement:$("filter-movement").value,orient:$("filter-orient").value,res:$("filter-res").value,duration:$("filter-duration").value,time:$("filter-time").value};
  filters.reviewStatus=$("review-status-filter").value;filters.suggestion=$("suggestion-filter").value;
  let matches=searchRows(all,$("search").value,state.generalOnly?null:state.client,$("include-general").checked || state.generalOnly,state.view==="review",filters);
  if(state.generalOnly)matches=matches.filter(generalApproved);
  if(state.view==="review" && $("review-batch").value)matches=matches.filter(function(r){return (r.project || "Unassigned shoot")===$("review-batch").value;});
  if(state.view==="review" && $("review-order").value==="learn")matches.sort(function(a,b){return learningPriority(a)-learningPriority(b) || a.name.localeCompare(b.name);});
  if(state.view==="review" && $("review-order").value==="source")matches.sort(function(a,b){return a.name.localeCompare(b.name);});
  $("sort-label").textContent=state.view==="review"?$("review-order").selectedOptions[0].textContent:"Quality first · then relevance";
  const hasMore=matches.length>state.visibleLimit;
  $("result-count").textContent="Checking source access…";
  const permitted=await pool(matches.slice(0,state.visibleLimit),6,async function(record){return await accessible(record)?record:null;});
  if(generation!==state.generation)return;
  matches=permitted.filter(Boolean);
  state.reviewOrder=matches.map(function(r){return r.file_id;});
  $("results").replaceChildren();
  if(state.view==="review"){
    const groups=new Map();
    matches.forEach(function(record){const project=record.project || "Unassigned shoot";if(!groups.has(project))groups.set(project,[]);groups.get(project).push(record);});
    groups.forEach(function(records,project){const heading=element("div","batch-heading",project.split("/").filter(Boolean).slice(-1)[0]);heading.append(element("span","",records.length+" files"));$("results").append(heading,...records.map(makeCard));});
  }else $("results").append(...matches.map(makeCard));
  $("load-more").classList.toggle("hidden",!hasMore);
  $("result-count").textContent=matches.length+" "+(state.view==="review"?"files to review":"clips")+(state.pending.length?" · "+state.pending.length+" pending decisions":"")+(hasMore?" · more available":"");
  $("empty").classList.toggle("hidden",matches.length>0);
  if(!matches.length){$("empty").querySelector("h2").textContent=state.view==="review"?"This queue is clear.":"No clips match this view yet.";$("empty").querySelector("p").textContent=state.view==="review"?"Newly processed files will appear here for human review.":"Try another search or open the review queue. Only approved footage appears in the library.";}
  $("try-demo").classList.add("hidden");
  state.bulk=matches.filter(function(r){return r.human?.status==="needs_review" && r.pipeline_status==="analyzed" && r.ai?.suggested_tier==="hero" && !(r.ai?.safety_flags || []).length;});
  $("bulk-approve").classList.toggle("hidden",state.view!=="review" || !canReview() || !state.bulk.length);
  updateSelected();
}
function renderActivity(records) {
  const panel=$("activity");panel.replaceChildren(element("h2","","Recent library activity"),element("p","","Human decisions are append-only Dropbox files. The processor merges them into the shared catalog."));
  if(state.processingStatus?.paused_reason)panel.append(element("p","",state.processingStatus.paused_reason));
  Object.entries(state.processingStatus?.clients || {}).forEach(function(entry){
    const client=(state.allowedClients || []).find(function(c){return c.slug===entry[0];});if(!client)return;
    const counts=entry[1],row=element("div","activity-row",client.name+" · "+(counts.analyzed || 0)+" analyzed · "+(counts.failed || 0)+" failed");
    row.append(element("span","",(counts.inventoried || 0)+" awaiting analysis · "+(counts.approved || 0)+" approved · "+(counts.ai_input_tokens || 0)+" AI input tokens measured"));panel.append(row);
  });
  state.pending.slice().reverse().forEach(function(event){const row=element("div","activity-row","Pending · "+event.decision.status+" · "+event.file_id);row.append(element("span","",new Date(event.created_at).toLocaleString()));panel.append(row);});
  records.flatMap(function(record){return (record.usage || []).map(function(usage){return {record:record,usage:usage};});}).sort(function(a,b){return b.usage.at.localeCompare(a.usage.at);}).slice(0,30).forEach(function(item){const row=element("div","activity-row",item.record.name+" · "+item.usage.project);row.append(element("span","",item.usage.by+" · "+new Date(item.usage.at).toLocaleDateString()));panel.append(row);});
  if(!state.pending.length && !records.some(function(r){return r.usage?.length;}))panel.append(element("p","","No merged usage events yet. Editors and AI can log a clip with broll used."));
}
function speechTime(value) {const n=Math.max(0,Math.floor(value || 0));return Math.floor(n/60)+":"+String(n%60).padStart(2,"0");}
function renderSpeech(record) {
  const panel=$("detail-speech");panel.replaceChildren(element("div","eyebrow","SPOKEN CONTENT"));
  const speech=record.speech,spoken=record.ai?.spoken;
  if(!speech){panel.append(element("p","field-help","Speech indexing has not run for this file."));return;}
  if(speech.status==="no_audio"){panel.append(element("p","field-help","This file has no audio track."));return;}
  if(speech.status==="no_speech_detected"){panel.append(element("p","field-help","Automatic transcription did not detect intelligible speech. Confirm by playback."));return;}
  if(spoken?.summary)panel.append(element("p","",spoken.summary));
  if(spoken?.topics?.length){const tags=element("div","tags");spoken.topics.forEach(function(t){tags.append(element("span","tag",t));});panel.append(tags);}
  if(spoken?.people?.length){panel.append(element("h3","","Names heard"),element("p","field-help","Automatic name candidates. Check spelling and attribution against the audio."));spoken.people.forEach(function(p){const label={self_introduced:"Self-introduction",introduced:"Introduced person",mentioned:"Mentioned person"}[p.relationship] || "Name mentioned";panel.append(element("p","speech-person",label+" · "+speechTime(p.start)+" · "+p.name),element("blockquote","speech-quote",p.evidence_quote));});}
  if(spoken?.moments?.length){const moments=element("details","");moments.append(element("summary","","Spoken moments"));spoken.moments.forEach(function(m){moments.append(element("p","",speechTime(m.start)+"–"+speechTime(m.end)+" · "+m.topic+" — "+m.summary));});panel.append(moments);}
  const transcript=element("details","");transcript.append(element("summary","","Transcript · "+(speech.segments?.length || 0)+" passages"));const rows=element("div","transcript-rows");(speech.segments || []).forEach(function(r){rows.append(element("p","",speechTime(r.start)+"–"+speechTime(r.end)+" · "+r.text));});transcript.append(rows);panel.append(transcript,element("p","field-help","Automatic transcript · source-relative timestamps · "+(spoken?.context_complete===false?"summary uses selected passages":"complete available audio analyzed")));
}
async function openDetail(record) {
  state.active=record;
  $("detail-name").textContent=record.name;
  $("detail-description").textContent=record.ai?.description || "This file is inventoried and waiting for analysis.";
  renderSpeech(record);
  const suggestion=$("quality-suggestion");suggestion.replaceChildren(element("div","eyebrow","PROVISIONAL AI SUGGESTION"),element("h3","",qualityLabel(record)));
  if(record.quality){suggestion.append(element("p","",record.quality.reason),element("p","field-help","About "+record.quality.minimum_usable_seconds+" usable seconds targeted · "+(record.quality.confidence<.7?"uncertain suggestion":"playback confirmation required")+". Your decision is separate."));}
  else suggestion.append(element("p","field-help","This clip is waiting for the new quality assessment."));
  $("feedback-reasons").replaceChildren();
  Object.entries(REASONS).forEach(function(entry){const label=element("label","feedback-chip"),input=element("input");input.type="checkbox";input.value=entry[0];input.checked=(record.human?.feedback_reasons || []).includes(entry[0]);input.disabled=!canReview();label.append(input,element("span","",entry[1]));$("feedback-reasons").append(label);});
  $("feedback-note").value=record.human?.feedback_note || "";$("feedback-note").disabled=!canReview();
  $("feedback-details").open=!!record.human?.feedback_reasons?.length || !!record.human?.feedback_note;
  $("detail-path").textContent=record.path;
  $("detail-tags").replaceChildren(...Object.values(effectiveTags(record)).flat().filter(function(tag){return !["none","unknown"].includes(tag);}).map(function(tag){return element("span","tag",tag);}));
  $("detail-sheet").classList.toggle("hidden",record.pipeline_status!=="analyzed");
  $("detail-no-sheet").classList.toggle("hidden",record.pipeline_status==="analyzed");
  $("detail-sheet").removeAttribute("src");
  if(record.pipeline_status==="analyzed")imageUrl(record,true).then(function(url){if(state.active?.file_id===record.file_id)$("detail-sheet").src=url;}).catch(function(){});
  $("review-status").textContent=(record.human?.status || "needs_review").replaceAll("_"," ")+(record.human?.pending?" · saved, awaiting merge":"");
  $("review-tier").value=record.human?.tier && record.human.tier!=="reject"?record.human.tier:(record.ai?.suggested_tier!=="reject"?record.ai?.suggested_tier:"solid") || "solid";
  $("review-notes").value=record.human?.notes || record.ai?.best_section_note || "";
  $("review-general").checked=record.human?.general_use_cleared===true;
  $("review-general").disabled=!generalSafe(record) || !canReview();
  $("general-reason").textContent=generalSafe(record)?"Clear this separately from approving quality.":"General use is blocked for this source or its safety flags.";
  const flags=record.ai?.safety_flags || [];
  $("safety-flags").textContent=flags.length?"Check before publication:\n"+flags.map(function(flag){return "• "+flag.replaceAll("_"," ");}).join("\n"):"No safety concerns were detected in sampled frames. Confirm by playback.";
  $("safety-review-label").classList.toggle("hidden",!flags.length);
  $("safety-reviewed").checked=record.human?.safety_reviewed===true;
  $("technical-notes").textContent=(record.last_error?"Processing issue: "+record.last_error+" ":"")+(record.usage?.length?"Used in "+record.usage.length+" project(s). ":"")+(record.technical?.limitations || []).join(" ");
  $("tag-inputs").replaceChildren();
  const tags=effectiveTags(record);
  FACETS.forEach(function(facet){const label=element("label","",facet.replaceAll("_"," "));const input=element("input");input.value=(tags[facet] || []).join(", ");input.dataset.facet=facet;input.disabled=!canReview();label.append(input);$("tag-inputs").append(label);});
  const ready=canReview() && record.pipeline_status==="analyzed" && !!record.rev;
  $("approve").disabled=!ready;$("reject").disabled=!ready;
  $("review-notes").disabled=!ready;$("review-tier").disabled=!ready;
  $("add-pull").disabled=record.human?.status!=="approved";
  if(!$("detail-dialog").open)$("detail-dialog").showModal();
}
async function saveDecision(record,status,overrides={}) {
  if(!canReview() || !record.rev || record.pipeline_status!=="analyzed")throw new Error("This file is not ready for review.");
  const original=record.ai?.tags || {}, added={},removed={};
  document.querySelectorAll("#tag-inputs input").forEach(function(input){
    const facet=input.dataset.facet,next=input.value.split(",").map(function(x){return x.trim();}).filter(Boolean);
    added[facet]=next.filter(function(x){return !(original[facet] || []).includes(x);});
    removed[facet]=(original[facet] || []).filter(function(x){return !next.includes(x);});
  });
  const decision={status:status,tier:status==="rejected"?"reject":$("review-tier").value,general_use_cleared:status==="approved" && $("review-general").checked,safety_reviewed:$("safety-reviewed").checked,notes:$("review-notes").value,tags_added:added,tags_removed:removed,...overrides};
  const useForm=$("detail-dialog").open && state.active?.file_id===record.file_id;
  decision.feedback_reasons=useForm?[...$("feedback-reasons").querySelectorAll("input:checked")].map(function(input){return input.value;}):[];
  decision.feedback_note=useForm?$("feedback-note").value:"";
  decision.proposal_id=record.quality?.proposal_id || null;
  if(decision.feedback_reasons.length>5)throw new Error("Choose up to five main reasons.");
  if(status==="approved" && record.ai?.safety_flags?.length && !decision.safety_reviewed)throw new Error("Confirm that you checked the publication and safety concerns.");
  if(decision.general_use_cleared && !generalSafe(record))throw new Error("This file cannot enter the general-use pool.");
  const event={schema_version:1,type:"human_decision",actor_kind:"human",human_confirmation:true,file_id:record.file_id,source_rev:record.rev,base_decision_id:record.human?.decision_id || null,reviewer_account_id:state.account?.account_id || "demo-reviewer",created_at:new Date().toISOString(),decision:decision};
  if(state.demo){event.event_id="demo:"+crypto.randomUUID();state.pending.push(event);return;}
  await tokenReady();
  const folder="decisions/"+state.account.account_id.replace(/[^A-Za-z0-9_-]/g,"_");
  try{await api("files/create_folder_v2",{path:child(folder),autorename:false});}catch(error){if(!String(error.message).includes("conflict"))throw error;}
  const filename=new Date().toISOString().replace(/[-:.TZ]/g,"")+"-"+crypto.randomUUID()+"-"+key(record)+".json";
  const args={path:child(folder+"/"+filename),mode:{".tag":"add"},autorename:false,mute:true,strict_conflict:true};
  const response=await fetch("https://content.dropboxapi.com/2/files/upload",{method:"POST",headers:{Authorization:"Bearer "+state.token,"Dropbox-API-Path-Root":JSON.stringify({".tag":"namespace_id",namespace_id:state.config.namespaceId}),"Content-Type":"application/octet-stream","Dropbox-API-Arg":ascii(args)},body:JSON.stringify(event),signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error("The decision was not saved. No approval was applied.");
  const metadata=await response.json();event.event_id=metadata.id+":"+metadata.rev;state.pending.push(event);
  if(location.hostname==="127.0.0.1")fetch("./review-sync",{method:"POST",headers:{"X-Broll-Review-Sync":"1"},signal:AbortSignal.timeout(5000)}).catch(function(){});
}
async function decide(status) {
  try {
    const advance=$("review-next").checked && state.view==="review";
    const order=state.reviewOrder || [],index=order.indexOf(state.active.file_id),nextIds=order.slice(index+1);
    $("approve").disabled=true;$("reject").disabled=true;
    await saveDecision(state.active,status);
    $("detail-dialog").close();
    notice(state.demo?"Demo decision applied locally. No Dropbox file was written.":"Decision saved to Dropbox. It is visible here while the processor merges it.");
    await render();
    if(advance){const nextId=nextIds.find(function(id){return state.reviewOrder?.includes(id);});const next=rowsWithPending().find(function(r){return r.file_id===nextId;});if(next)await openDetail(next);}
  }catch(error){notice(error.message,true);$("approve").disabled=false;$("reject").disabled=false;}
}
function dropboxUrl(record) {const split=record.path.lastIndexOf("/");return "https://www.dropbox.com/home"+record.path.slice(0,split).split("/").map(encodeURIComponent).join("/")+"?preview="+encodeURIComponent(record.path.slice(split+1));}
function exportPullList() {
  const records=rowsWithPending().filter(function(record){return state.selected.has(record.file_id) && record.human?.status==="approved";});
  const text=records.map(function(record){return record.file_id+"\n"+record.path+"\n"+dropboxUrl(record)+"\n";}).join("\n");
  const url=URL.createObjectURL(new Blob([text],{type:"text/plain;charset=utf-8"}));
  const anchor=element("a");anchor.href=url;anchor.download="broll-pull-list.txt";anchor.click();setTimeout(function(){URL.revokeObjectURL(url);},5000);
}
function startDemo() {
  state.demo=true;state.pending=[];state.selected.clear();state.view="browse";state.generalOnly=false;state.client="demo-landscaping";
  state.account={account_id:"demo-reviewer",name:{display_name:"Demo editor"}};
  state.allowedClients=[{name:"Example Landscaping",slug:"demo-landscaping"},{name:"Example Recreation",slug:"demo-recreation"}];
  state.manifest={generated_at:new Date().toISOString(),reviewer_account_ids:["demo-reviewer"],clients:state.allowedClients};
  const descriptions=["Aerial view of a landscaped property in warm evening light.","Wide view of a finished outdoor seating area.","Close view of stonework and planting details.","Trees and open space in soft morning light.","A quiet walkway through a completed garden.","Aerial view of a lake and surrounding hills.","Detail of tools arranged at a worksite.","An empty recreation space ready for the day.","A landscape overview with no identifiable people.","A finished garden with warm evening light.","A static view of an empty outdoor courtyard.","A worksite detail that needs a reviewer’s decision."];
  state.records=descriptions.map(function(description,i){
    const tags=Object.fromEntries(FACETS.map(function(facet){return [facet,[]];}));
    Object.assign(tags,{subject:[i===5?"water":"landscape"],action:[],setting:["exterior"],shot_type:[i%3===0?"aerial":i%3===1?"wide":"detail"],camera_movement:[i%3===0?"push":"static"],people:["none"],time_of_day:[i%2?"day":"golden-hour"]});
    const pending=i>=9;
    return {file_id:"id:demo_"+i,file_key:"demo_"+i,name:"EXAMPLE_"+String(i+1).padStart(3,"0")+".MP4",rev:"demo-rev-1",client:i===7?"Example Recreation":"Example Landscaping",client_slug:i===7?"demo-recreation":"demo-landscaping",path:"/EXAMPLES ONLY/Footage/EXAMPLE_"+String(i+1).padStart(3,"0")+".MP4",role:"b-roll",availability:"current",exclusion_reason:null,pipeline_status:"analyzed",technical:{duration:18+i*3,width:3840,height:2160,orientation:"h",fps:24,limitations:["Demo preview only. This is not real footage."]},ai:{description:description,tags:tags,suggested_tier:i%4===0 || pending?"hero":"solid",safety_flags:[],general_use_suggestion:i===5,best_section_note:null},human:{status:pending?"needs_review":"approved",tier:pending?null:i%4===0?"hero":"solid",general_use_cleared:i===5,tags_added:{},tags_removed:{},decision_id:null,safety_reviewed:false},usage:[],demo_index:i};
  });
  $("demo-banner").classList.remove("hidden");$("connect").classList.remove("hidden");$("connect").textContent="Connect real Dropbox";$("signout").classList.remove("hidden");$("connection-status").textContent="Demo workspace";$("updated").textContent="Synthetic demo · nothing is stored in Dropbox";setAccount();buildClients();notice("");render();
}
function signout() {state.token=null;state.refreshToken=null;state.account=null;state.records=[];state.pending=[];state.selected.clear();state.blobs.forEach(URL.revokeObjectURL);state.blobs.clear();location.assign(location.pathname);}
function bind() {
  $("connect").addEventListener("click",function(){connect().catch(function(error){notice(error.message,true);});});
  $("try-demo").addEventListener("click",startDemo);
  $("signout").addEventListener("click",signout);
  $("refresh").addEventListener("click",function(){if(state.demo)render();else if(state.token)loadCatalog().catch(function(error){notice(error.message,true);});else notice("Connect Dropbox to refresh your library.");});
  document.querySelectorAll("[data-view]").forEach(function(button){button.addEventListener("click",function(){if(!state.manifest)return;state.view=button.dataset.view;state.visibleLimit=48;render();});});
  ["search","filter-tier","filter-shot","filter-movement","filter-orient","filter-res","filter-duration","filter-time","include-general","review-batch","review-status-filter","suggestion-filter","review-order"].forEach(function(id){$(id).addEventListener(id==="search"?"input":"change",function(){state.visibleLimit=48;if(state.manifest)render();});});
  $("load-more").addEventListener("click",function(){state.visibleLimit+=48;render();});
  $("general-pool").addEventListener("click",function(){if(!state.manifest)return;state.generalOnly=true;state.view="browse";buildClients();render();});
  $("pull-list").addEventListener("click",exportPullList);
  $("detail-close").addEventListener("click",function(){$("detail-dialog").close();});
  $("approve").addEventListener("click",function(){decide("approved");});
  $("reject").addEventListener("click",function(){decide("rejected");});
  $("open-dropbox").addEventListener("click",function(){if(state.demo){notice("This is a synthetic demo file. No real Dropbox footage is linked.");return;}accessible(state.active).then(function(ok){if(ok)window.open(dropboxUrl(state.active),"_blank","noopener,noreferrer");else notice("Source access or revision changed. Refresh before opening.",true);});});
  $("copy-path").addEventListener("click",function(){navigator.clipboard.writeText(state.active.path).then(function(){notice("Dropbox path copied. A local sync path depends on each editor’s Dropbox setup.");});});
  $("add-pull").addEventListener("click",function(){toggleSelection(state.active);$("add-pull").textContent=state.selected.has(state.active.file_id)?"Remove from pull list":"Add to pull list";});
  $("bulk-approve").addEventListener("click",function(){$("bulk-description").textContent=state.bulk.length+" AI hero suggestions without detected safety flags. Approval is your decision; general use stays off.";$("bulk-files").replaceChildren();const list=element("ul");state.bulk.forEach(function(record){list.append(element("li","",record.name+" — "+title(record)));});$("bulk-files").append(list);$("bulk-confirm").checked=false;$("bulk-save").disabled=true;$("bulk-dialog").showModal();});
  $("bulk-confirm").addEventListener("change",function(){$("bulk-save").disabled=!$("bulk-confirm").checked;});
  $("bulk-cancel").addEventListener("click",function(){$("bulk-dialog").close();});
  $("bulk-save").addEventListener("click",async function(){
    if(!$("bulk-confirm").checked)return;
    $("bulk-save").disabled=true;
    try{for(const record of state.bulk){await saveDecision(record,"approved",{tier:"hero",general_use_cleared:false,safety_reviewed:false,tags_added:record.human?.tags_added || {},tags_removed:record.human?.tags_removed || {},notes:record.human?.notes || ""});}$("bulk-dialog").close();notice("Human-confirmed hero decisions saved. General-use clearance remains separate.");await render();}
    catch(error){notice(error.message,true);$("bulk-save").disabled=false;}
  });
  document.addEventListener("keydown",function(event){
    if(["INPUT","TEXTAREA","SELECT"].includes(document.activeElement?.tagName))return;
    if(event.key==="/" && !$("detail-dialog").open){event.preventDefault();$("search").focus();}
    if(!$("detail-dialog").open)return;
    const value=event.key.toLowerCase();
    if(value==="a" && !$("approve").disabled)decide("approved");
    else if(value==="r" && !$("reject").disabled)decide("rejected");
    else if(["1","2","3"].includes(value))$("review-tier").value={1:"hero",2:"solid",3:"filler"}[value];
    else if(value==="g" && !$("review-general").disabled)$("review-general").checked=!$("review-general").checked;
    else if(value==="e"){$("tag-editor").open=true;$("tag-inputs").querySelector("input")?.focus();}
  });
}
async function init() {
  bind();
  try{state.config=await fetch("./config.json",{cache:"no-store"}).then(function(response){return response.json();});if(new URLSearchParams(location.search).get("demo")==="1"){startDemo();return;}await callback();}
  catch(error){notice(error.message,true);}
  setInterval(function(){if(state.token && !state.demo && !$("detail-dialog").open && !$("bulk-dialog").open)loadCatalog().catch(function(error){notice(error.message,true);});},45000);
}
init();
