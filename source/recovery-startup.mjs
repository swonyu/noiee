export const RECOVERY_STARTUP_MESSAGE='Recovery startup holds unrestricted tools. Full Access remains selected. Finish the retained recovery, or cancel recovery startup in the app menu for the next launch.';

export function validateToolAccess({fullAccess,unconfinedBoot,recoveryStartup=false}){
 if([fullAccess,unconfinedBoot,recoveryStartup].some(value=>typeof value!=='boolean')||recoveryStartup&&(!fullAccess||unconfinedBoot)||fullAccess&&!unconfinedBoot&&!recoveryStartup)throw Error('Invalid native tool access mode.');
}

// These are admission categories; each existing handler still validates its full
// body, current owner, scope and one-time review. Unknown routes never dispatch.
export function recoveryStartupAllows(route,input){
 if(['/api/tools/stop','/api/tools/depart','/api/tools/shutdown','/api/tools/shutdownStatus','/api/tools/disconnect'].includes(route))return true;
 if(route==='/api/tools/worktrees')return ['list','stop','prepareReconnect','commitReconnect','prepareHandoffRecovery','recoverHandoff','prepareRecoveryCopy','createRecoveryCopy','prepareArchive','archive','prepareRestore','restore'].includes(input?.action);
 if(route==='/api/tools/coding')return ['goalInspect','goalPause','status','events','list','read','historyPage','readImage','family','mcpOutcomes','terminalResults','providerBindingInfo','approvalInfo','terminalSnapshot','interrupt','interruptFamily','terminalStop'].includes(input?.action)||input?.action==='approval'&&input.decision==='decline';
 if(['/api/tools/git','/api/tools/schedules'].includes(route))return input?.action==='stop';
 if(route==='/api/tools/codingQueue')return ['pause','cancel'].includes(input?.action);
 if(route==='/api/tools/codingMCP')return input?.action==='cancelSetup';
 return false;
}
