import {captureLeadSchema,csvColumns,type ImportRow} from './capture.ts';
import {ApiError} from '../server/http.ts';
export const CSV_MAX_BYTES=5*1024*1024;
// RFC-style quoted cells, embedded newlines and escaped quotes. Values stay plain text.
export function parseCsv(text:string){
 if(new TextEncoder().encode(text).length>CSV_MAX_BYTES)throw new ApiError(413,'CSV_TOO_LARGE','CSV files must be at most 5 MB.');
 if(text.includes('\0'))throw new ApiError(422,'INVALID_CSV','CSV contains unsupported null characters.');
 text=text.replace(/^\uFEFF/,'');const rows:string[][]=[];let row:string[]=[],cell='',quoted=false,closed=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=c;continue;}
  if(c==='"'){if(cell||closed)throw new ApiError(422,'INVALID_CSV','Unexpected quote in CSV.');quoted=true;}
  else if(c===','||c==='\n'||c==='\r'){row.push(cell);cell='';closed=false;if(c!==','){if(c==='\r'&&text[i+1]==='\n')i++;rows.push(row);row=[];if(rows.length>1001)throw new ApiError(422,'CSV_ROW_LIMIT','Use at most 1,000 data rows.');}}
  else{if(closed)throw new ApiError(422,'INVALID_CSV','Unexpected text after a quoted cell.');cell+=c;}
 }
 if(quoted)throw new ApiError(422,'INVALID_CSV','A quoted cell is not closed.');if(row.length||cell||closed){row.push(cell);rows.push(row);}
 if(rows.length<2||rows.length>1001)throw new ApiError(422,'CSV_ROW_LIMIT','Use 1–1,000 data rows.');
 const headers=rows.shift()!.map(v=>v.trim());if(headers.some(v=>!v)||new Set(headers).size!==headers.length||headers.length>40)throw new ApiError(422,'CSV_HEADERS','Use unique, nonempty headers (at most 40).');
 if(headers.some(v=>/^(tenant(id)?|agency(id)?|creator(id)?|createdby|actor(id)?|role|assigneeid|userid)$/i.test(v.replace(/[^a-z0-9]/gi,''))))throw new ApiError(422,'AUTHORITY_COLUMN','Remove identity, tenant, role and assignment ID columns.');
 return {headers,cells:rows};
}
export function mapCsv(text:string,mapping:Record<string,string>):ImportRow[]{
 const {headers,cells}=parseCsv(text);const targets=Object.values(mapping).filter(Boolean);
 if(Object.keys(mapping).some(k=>!headers.includes(k))||targets.some(v=>!csvColumns.includes(v as typeof csvColumns[number]))||new Set(targets).size!==targets.length||!targets.includes('full_name'))throw new ApiError(422,'CSV_MAPPING','Map unique supported fields, including full_name.');
 return cells.map((cells,row)=>{
  const payload:Record<string,unknown>={};if(cells.length!==headers.length)return {row_index:row+1,errors:{_row:'Column count does not match the header.'}};
  headers.forEach((header,index)=>{const target=mapping[header];if(!target)return;const value=cells[index].trim();if(['budget_min','budget_max','bedrooms'].includes(target))payload[target]=value===''?null:/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)?Number(value):value;else if(target==='locations')payload[target]=value?value.split('|').map(v=>v.trim()):[];else if(target==='currency')payload[target]=value||null;else if(['confirmed_intent','property_type','purchase_timeline','source_reference'].includes(target))payload[target]=value||null;else if(target==='budget_period')payload[target]=value||'UNKNOWN';else payload[target]=value;});
  const assignee=payload.assignee_email;delete payload.assignee_email;const checked=captureLeadSchema.safeParse(payload);const errors:Record<string,string>={};
  if(!checked.success)for(const issue of checked.error.issues)errors[issue.path.join('.')||'_row']=issue.message;
  if(assignee&& (typeof assignee!=='string'||!/^\S+@\S+\.\S+$/.test(assignee)))errors.assignee_email='Use an active teammate email.';
  return Object.keys(errors).length?{row_index:row+1,errors}:{row_index:row+1,payload:{...checked.data,assignee_email:assignee||''}};
 });
}
