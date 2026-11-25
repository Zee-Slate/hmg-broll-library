export const FACETS = ["subject","action","setting","location","shot_type","camera_movement","time_of_day","season_weather","people","brand_elements"];
export const BLOCKING = new Set(["identifiable_people","minors","people_in_care_setting","license_plates","private_information","competitor_branding","uncertain_people_visibility"]);
export const RANK = {hero:0,solid:1,filler:2,reject:3};

export function originalPlaybackLink(record, response) {
  if(!record.rev || response?.metadata?.id!==record.file_id || response.metadata.rev!==record.rev)throw new Error("The original changed or is no longer available. Refresh the library before reviewing it.");
  let url;try{url=new URL(response.link);}catch(error){throw new Error("Dropbox did not return a playable original link.");}
  if(url.protocol!=="https:" || url.username || url.password || !(url.hostname.endsWith(".dropboxusercontent.com") || url.hostname==="dl.dropbox.com"))throw new Error("Dropbox did not return a playable original link.");
  return url.href;
}

export function reviewTier(record) {
  return [record.human?.tier,record.quality?.suggested_tier,record.ai?.suggested_tier,"solid"].find(function(tier){return ["hero","solid","filler"].includes(tier);});
}

export function reviewDecision(record, status, fields={}) {
  if(!["approved","rejected"].includes(status))throw new Error("Choose Keep or Reject.");
  const human=record.human || {};
  const decision={status:status,tier:status==="rejected"?"reject":fields.tier ?? reviewTier(record),
    general_use_cleared:status==="approved" && (fields.general_use_cleared ?? human.general_use_cleared ?? false),
    safety_reviewed:fields.safety_reviewed ?? human.safety_reviewed ?? false,
    notes:fields.notes ?? human.notes ?? record.ai?.best_section_note ?? "",
    tags_added:fields.tags_added ?? human.tags_added ?? {},tags_removed:fields.tags_removed ?? human.tags_removed ?? {},
    feedback_reasons:fields.feedback_reasons ?? human.feedback_reasons ?? [],feedback_note:fields.feedback_note ?? human.feedback_note ?? "",
    proposal_id:record.quality?.proposal_id || null};
  if(status==="approved" && !["hero","solid","filler"].includes(decision.tier))throw new Error("Choose a quality tier.");
  if(!Array.isArray(decision.feedback_reasons) || decision.feedback_reasons.length>5)throw new Error("Choose up to five main reasons.");
  if(typeof decision.feedback_note!=="string" || decision.feedback_note.length>1200)throw new Error("Training notes must be at most 1200 characters.");
  if(status==="approved" && record.ai?.safety_flags?.length && !decision.safety_reviewed)throw new Error("Confirm that you checked the publication and safety concerns.");
  if(decision.general_use_cleared && !generalSafe(record))throw new Error("This file cannot enter the general-use pool.");
  return decision;
}

export class CatalogUpdatingError extends Error {
  constructor(){super("New clips are still being added. Please try opening the library again shortly.");this.name="CatalogUpdatingError";}
}

export function requireCatalogGeneration(manifest, documents) {
  if(!manifest?.generated_at || documents.some(function(doc){return doc?.generated_at!==manifest.generated_at;}))throw new CatalogUpdatingError();
}

export function createCatalogLoader(read,{onStart=function(){},onUpdating=function(){},onFinish=function(){},wait=function(ms){return new Promise(function(resolve){setTimeout(resolve,ms);});},now=Date.now,retryMs=5000,maxWaitMs=300000}={}) {
  let active=null;
  return function load() {
    if(active)return active;
    active=(async function(){
      const started=now();onStart();
      while(true){
        try{return await read();}
        catch(error){
          if(!(error instanceof CatalogUpdatingError) || now()-started>=maxWaitMs)throw error;
          onUpdating();await wait(retryMs);
        }
      }
    })().finally(function(){active=null;onFinish();});
    return active;
  };
}

export function canReviewCatalog(manifest, account, metadata) {
  if(!account?.account_id)return false;
  if((manifest?.reviewer_account_ids || []).includes(account.account_id))return true;
  const sharing=metadata?.sharing_info;
  return manifest?.reviewer_access==="catalog_writers" && Boolean(manifest?.namespace_id) &&
    sharing?.parent_shared_folder_id===manifest.namespace_id && sharing?.read_only===false &&
    !sharing.no_access && !sharing.traverse_only;
}

export function effectiveTags(record) {
  const result = {};
  FACETS.forEach(function(facet) {
    const tags = new Set(record.ai?.tags?.[facet] || []);
    (record.human?.tags_added?.[facet] || []).forEach(function(tag) { tags.add(tag); });
    (record.human?.tags_removed?.[facet] || []).forEach(function(tag) { tags.delete(tag); });
    result[facet] = [...tags].sort();
  });
  return result;
}

export function generalSafe(record) {
  if (record.exclusion_reason || record.role === "a-roll" || record.availability !== "current" || record.pipeline_status !== "analyzed") return false;
  if ((record.ai?.safety_flags || []).some(function(flag) { return BLOCKING.has(flag); })) return false;
  if (record.ai?.spoken?.people?.length) return false;
  const people = effectiveTags(record).people;
  return people.length > 0 && !people.some(function(tag) { return ["identifiable","minors","unknown"].includes(tag); });
}

export function generalApproved(record) {
  return record.human?.status === "approved" && ["hero","solid","filler"].includes(record.human?.tier) && record.human?.general_use_cleared === true && generalSafe(record);
}

export function inContext(record, client, includeGeneral = true, includeUnreviewed = false) {
  if (record.exclusion_reason || record.role === "a-roll" || record.availability !== "current") return false;
  if (record.human?.status !== "approved" && !includeUnreviewed) return false;
  return (client && record.client_slug === client) || (includeGeneral && generalApproved(record));
}

export function applyPending(record, pending) {
  let result = structuredClone(record);
  pending.filter(function(event) { return event.file_id === record.file_id; }).forEach(function(event) {
    if (event.source_rev !== result.rev || !result.rev || event.base_decision_id !== (result.human?.decision_id || null)) return;
    const human = {...result.human, ...event.decision, decision_id:event.event_id, pending:true};
    result = {...result,human:human};
    if (!generalSafe(result)) result.human.general_use_cleared = false;
  });
  return result;
}

export function searchRows(records, query, client, includeGeneral, review, filters = {}) {
  const aliases = {drone:["drone","aerial"],sunset:["sunset","golden","dusk"],dusk:["dusk","golden"],closeup:["close","detail"]};
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const tokens = words.filter(function(word) { return !["a","an","the","of","at","in","on","with","and","over","for","to"].includes(word); });
  const rows = [];
  records.forEach(function(record) {
    if (!inContext(record,client,includeGeneral,review)) return;
    if (review && (record.pipeline_status !== "analyzed" || (filters.reviewStatus!=="all" && record.human?.status !== (filters.reviewStatus || "needs_review")))) return;
    if (review && filters.suggestion && record.quality?.decision !== filters.suggestion) return;
    const tags = effectiveTags(record), technical = record.technical || {};
    if (filters.tier && record.human?.tier !== filters.tier && !(review && record.ai?.suggested_tier === filters.tier)) return;
    if (filters.orient && technical.orientation !== filters.orient) return;
    if (Number(filters.res) > Math.max(technical.width || 0,technical.height || 0) || Number(filters.duration) > (technical.duration || 0)) return;
    if (filters.shot && !tags.shot_type.includes(filters.shot)) return;
    if (filters.movement && !tags.camera_movement.includes(filters.movement)) return;
    if (filters.time && !tags.time_of_day.includes(filters.time)) return;
    const text = [record.name,record.ai?.description || "",record.ai?.spoken?.summary || "",...(record.ai?.spoken?.topics || []),...(record.ai?.spoken?.people || []).map(function(p){return p.name;}),...(record.speech?.segments || []).map(function(r){return r.text;}),...(record.ai?.editorial_uses || []),...Object.values(tags).flat()].join(" ").toLowerCase();
    const score = tokens.reduce(function(total,word) { return total + (aliases[word] || [word]).filter(function(term) {return text.includes(term);}).length; },0);
    if (tokens.length && !score) return;
    rows.push({record:record,score:score});
  });
  rows.sort(function(a,b) {return (RANK[a.record.human?.tier || a.record.ai?.suggested_tier] ?? 9) - (RANK[b.record.human?.tier || b.record.ai?.suggested_tier] ?? 9) || b.score-a.score || a.record.file_id.localeCompare(b.record.file_id);});
  return rows.map(function(item) {return item.record;});
}
