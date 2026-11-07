// Shared browser/server policy. Saved model IDs and response-style values are stable.
(function (root) {
  'use strict';
  const DEFAULT_LOCAL_MODEL = 'qwen3.8-27b-uncensored-hauhaucs-aggressive-mtp';
  const MIN_CONTEXT = Object.freeze({chat:8192,agent:32768,coding:32768,deep:16384});
  function contextProfile(contextLength, options = {}) {
    const {mode='chat',effort='none',longOutput=false}=options;
    if(!['chat','agent','coding'].includes(mode)||!['none','high'].includes(effort)||typeof longOutput!=='boolean'||longOutput&&(effort!=='none'||mode==='coding'))throw Error('Invalid model context profile.');
    const minimum=Math.max(MIN_CONTEXT[mode],effort==='high'?MIN_CONTEXT.deep:0);
    if(!Number.isSafeInteger(contextLength)||contextLength<minimum)throw Error('Loaded context is too small for this model profile.');
    const responseReserve=mode==='coding'||effort==='high'?8192:longOutput?Math.max(4096,Math.min(8192,Math.floor(contextLength/4))):4096;
    const toolReserve=mode==='coding'?4096:0;
    const safetyReserve=mode==='coding'?2048:1024;
    const inputBudget=contextLength-responseReserve-toolReserve-safetyReserve;
    return Object.freeze({
      version:1,contextWindow:contextLength,responseReserve,toolReserve,safetyReserve,inputBudget,
      ...(mode==='coding'?{autoCompactTokenLimit:Math.floor(inputBudget/1024)*1024,toolOutputTokenLimit:4096}:{})
    });
  }
  function responseStyleInstructions(options={}) {
    const {mode='chat',effort='none'}=options;
    if(!['chat','agent','coding'].includes(mode)||!['none','high'].includes(effort)||Object.hasOwn(options,'longOutput')&&(options.longOutput!==true||effort!=='none'||mode==='coding'))throw Error('Invalid response style.');
    if(effort==='high')return 'Reason carefully and check assumptions. Present the answer and the useful supporting explanation clearly; follow the user’s requested length and format.';
    if(options.longOutput===true)return 'Response style: Detailed. By default, give a thorough answer with the relevant explanation, concrete steps, useful examples and qualifications. Follow the user’s requested length and format; avoid repetition.';
    return 'Response style: Concise. By default, give the direct answer and the essential next steps with brief supporting explanation. Expand when the task or the user’s requested length requires it.';
  }
  root.NoieeModelPolicy=Object.freeze({DEFAULT_LOCAL_MODEL,MIN_CONTEXT,contextProfile,responseStyleInstructions});
})(globalThis);
