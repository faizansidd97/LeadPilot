type FocusTarget={
 isConnected:boolean;
 ownerDocument:{body:unknown;activeElement:unknown};
 focus:()=>void;
};

export function restoreDialogFocus(previous:FocusTarget|null,fallback:FocusTarget|null){
 if(previous?.isConnected&&previous!==previous.ownerDocument.body){
  previous.focus();
  if(previous.ownerDocument.activeElement===previous)return;
 }
 if(fallback?.isConnected)fallback.focus();
}
