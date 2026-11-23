export const REASONS = {
  usable_section:'Good usable section',clean_composition:'Good framing',clear_subject:'Clear subject',
  useful_action:'Useful action or detail',smooth_movement:'Good camera movement',shaky:'Unusable shake',
  soft_focus:'Missed focus',exposure_problem:'Unusable exposure',setup_only:'Setup or dead time only',
  obstructed:'Obstructed framing',too_short:'No five-second section',repetitive:'Repetitive shot',
  low_editorial_value:'Little editorial use',not_broll:'Not B-roll',privacy_or_release:'Privacy or release concern',
  needs_playback:'Needs playback',other:'Other reason'
};

export function qualityLabel(record) {
  const q=record.quality;
  return q ? 'AI suggests '+(q.decision==='keep'?'KEEP · '+q.suggested_tier.toUpperCase():'REJECT') : 'Quality assessment pending';
}

export function learningPriority(record) {
  const q=record.quality;
  if(!q)return 10;
  return (q.usable_section_evidence==='uncertain'?0:1)+(Number(q.confidence) || 0);
}

export function learningSummary(profile,pending=0) {
  if(!profile?.version)return 'Your decisions and reasons help build this client’s grading guide.';
  const a=profile.agreement || {};
  return 'Target: about '+profile.minimum_usable_seconds+' usable seconds · '+profile.human_examples+' verified learning examples · '+
    (a.compared ? a.matched+' of '+a.compared+' suggestions matched your decisions (reviewed sample)' : 'Agreement will appear after you review suggestions')+
    (pending ? ' · '+pending+' decisions awaiting merge' : '');
}
