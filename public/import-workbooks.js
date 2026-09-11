(function(root){
 'use strict';
 const fields={branch:{action:['action','tindakan'],id:['id','idcabang'],name:['name','nama','namacabang'],cv:['cv','namacv'],type:['type','tipe','tipecabang']},account:{role:['role','peran'],branchName:['branchname','namacabang'],branchType:['branchtype','tipecabang'],displayName:['displayname','namatampilan'],username:['username'],password:['password']}};
 const clean=value=>String(value??'').replace(/^\uFEFF/,'').trim();const key=value=>clean(value).toLowerCase().replace(/[\s_*]/g,'');
 function matrixRows(matrix,kind){
  const spec=fields[kind];let header=-1,mapping=[];
  for(let i=0;i<Math.min(matrix.length,20);i++){const columns=matrix[i].map(value=>Object.keys(spec).find(k=>spec[k].includes(key(value)))||'');if(Object.keys(spec).filter(k=>k!=='cv').every(k=>columns.includes(k))){header=i;mapping=columns;break;}}
  if(header<0)throw new Error('Header template '+(kind==='branch'?'cabang':'akun')+' tidak ditemukan. Gunakan template dari aplikasi.');
  if(mapping.filter(Boolean).length!==new Set(mapping.filter(Boolean)).size)throw new Error('Ada nama kolom yang berulang.');
  return matrix.slice(header+1).map((cells,i)=>{const row={_sourceRow:header+i+2};mapping.forEach((name,c)=>{if(name)row[name]=name==='password'?String(cells[c]??''):clean(cells[c]);});if(kind==='branch'){const actions={TAMBAH:'ADD',UBAH:'UPDATE',HAPUS:'DELETE'};row.action=actions[row.action.toUpperCase()]||row.action.toUpperCase();}return row;}).filter(row=>Object.keys(spec).some(k=>row[k]!=null&&row[k]!==''));
 }
 function csvMatrix(text){
  text=String(text||'').replace(/^\uFEFF/,'');const first=text.split(/\r?\n/,1)[0],separator=first.split(';').length>first.split(',').length?';':',';
  const rows=[];let row=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(c===separator&&!quoted){row.push(cell);cell='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);rows.push(row);row=[];cell='';}else cell+=c;}
  if(quoted)throw new Error('Tanda petik CSV belum ditutup.');if(cell||row.length){row.push(cell);rows.push(row);}return rows;
 }
 function workbookRows(workbook,kind,XLSX){const name=kind==='branch'?'Import Cabang':'Import Akun',sheet=workbook.Sheets[name]||workbook.Sheets[workbook.SheetNames[0]];if(!sheet)throw new Error('File tidak memiliki lembar data.');return matrixRows(XLSX.utils.sheet_to_json(sheet,{header:1,defval:'',raw:false,blankrows:true}),kind);}
 root.NotaImport={matrixRows,csvRows:(text,kind)=>matrixRows(csvMatrix(text),kind),workbookRows};
})(globalThis);
