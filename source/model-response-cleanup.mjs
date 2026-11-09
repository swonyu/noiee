// Failed or aborted responses have no usable output. Request cleanup without
// allowing a transport's pending/rejected cancellation to hide the real failure.
export function cancelModelBody(body){
  try{Promise.resolve(body?.cancel()).catch(()=>{});}catch{}
}
