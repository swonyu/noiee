import {contextProfile,validateModelID} from './local-models.mjs';

const changed=()=>Object.assign(new Error('The loaded model context changed after Tasks was prepared. Stop current work and restart Noiee to use the new context; no request was replayed.'),{code:'MODEL_CONTEXT_CHANGED',statusCode:409});
export function assertCodingContext(selected,expected) {
  if(!expected)throw Object.assign(new Error('The Tasks model context has not been admitted. Reopen the project before sending.'),{code:'MODEL_CONTEXT_UNCONFIRMED',statusCode:409});
  const actual=contextProfile(selected?.contextLength,{mode:'coding'});
  for(const key of ['version','contextWindow','responseReserve','toolReserve','safetyReserve','autoCompactTokenLimit','toolOutputTokenLimit'])if(actual[key]!==expected[key])throw changed();
  return actual;
}
// A loaded model window is immutable for an execution process. Retained thread
// identities and app-owned config files never become a model/context fallback.
export class CodingContextProfiles {
  #models=new Map();
  admit(id,selected) {
    validateModelID(id);
    if(selected?.id!==id)throw new Error('Local model inventory returned a different model identity.');
    const current=this.#models.get(id);
    if(current){assertCodingContext(selected,current);return current;}
    const value=contextProfile(selected.contextLength,{mode:'coding'});
    this.#models.set(id,value);return value;
  }
  get(id) {return this.#models.get(id);}
  require(id) {const value=this.get(validateModelID(id));if(!value)assertCodingContext(null,null);return value;}
  config(id) {
    const value=this.get(id);if(!value)return {};
    return {model_context_window:value.contextWindow,model_auto_compact_token_limit:value.autoCompactTokenLimit,model_auto_compact_token_limit_scope:'total',tool_output_token_limit:value.toolOutputTokenLimit};
  }
  clear() {this.#models.clear();}
}
