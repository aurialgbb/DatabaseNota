(function () {
  'use strict';
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k)+':'+canonical(value[k])).join(',') + '}';
    return JSON.stringify(value);
  }
  async function request(path, method, body, key) {
    const response = await fetch(path, {method,credentials:'same-origin',headers:method==='GET'?{}:{'content-type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:method==='GET'?undefined:JSON.stringify(body)});
    const envelope = await response.json();
    if (!response.ok || !envelope.ok) throw Object.assign(new Error(envelope.error?.message || 'Server belum merespons.'),{code:envelope.error?.code});
    return envelope.result;
  }
  async function upload(image, uploadId, branchId) {
    const content = image.base64 || image.data || '';
    const blob = await (await fetch('data:'+(image.mimeType||'image/jpeg')+';base64,'+content)).blob();
    const slot = await request('/api/uploads','POST',{size:blob.size,mimeType:blob.type,uploadId,branchId});
    const sent=await fetch(slot.uploadUrl,{method:'PUT',headers:{'content-type':blob.type},body:blob});
    if(!sent.ok) throw new Error('Foto belum berhasil diunggah.');
    if(image.thumbnailBase64){
      const thumbnail=await (await fetch('data:image/jpeg;base64,'+image.thumbnailBase64)).blob();
      const thumbResponse=await fetch(slot.thumbnailUploadUrl,{method:'PUT',headers:{'content-type':'image/jpeg'},body:thumbnail});
      if(!thumbResponse.ok) throw new Error('Thumbnail belum berhasil diunggah.');
    }
    await request('/api/uploads/'+slot.photoId+'/complete','POST',{});
    return slot.photoId;
  }
  async function waitJob(id) {
    const started=Date.now();
    for(;;){
      const job=await request('/api/jobs/'+id,'GET');
      if(job.status==='SUCCEEDED')return job.result;
      if(['FAILED','NEEDS_REVIEW','CANCELLED'].includes(job.status))throw new Error(job.message||'Pekerjaan perlu diperiksa.');
      window.dispatchEvent(new CustomEvent('nota-job-progress',{detail:job}));
      const delay=document.hidden?15000:Date.now()-started<10000?1000:Date.now()-started<60000?2000:5000;
      await new Promise(resolve=>setTimeout(resolve,delay));
    }
  }
  async function invoke(name,args){
    if(name==='getPortalSetupStatus')return request('/api/setup','GET');
    if(name==='portalLogin'){
      const value=await request('/api/auth/login','POST',args[0]);
      return {...value,sessionToken:'native-cookie'};
    }
    if(name==='portalGetSession')return request('/api/auth/session','GET');
    if(name==='portalLogout')return request('/api/auth/logout','POST',{});
    const legacy=name==='portalLegacyApi';
    if(!legacy&&name!=='portalApi')throw new Error('Tindakan tidak tersedia pada aplikasi baru.');
    const action=args[1], original=legacy?args[2]:args[2]||{};
    let payload=structuredClone(original);
    if(!legacy && action==='CHANGE_PASSWORD') {
      const confirm=await Swal.fire({title:'Konfirmasi password saat ini',input:'password',inputAttributes:{autocomplete:'current-password'},showCancelButton:true,confirmButtonText:'Lanjutkan',cancelButtonText:'Batal'});
      if(!confirm.isConfirmed || !confirm.value)throw new Error('Perubahan password dibatalkan.');
      payload.currentPassword=confirm.value;
    }
    const identity=canonical({legacy,action,payload});
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(identity)))).map(v=>v.toString(16).padStart(2,'0')).join('');
    const storageKey='nota-native-pending-'+digest;
    let key=sessionStorage.getItem(storageKey);
    if(!key){key=crypto.randomUUID();sessionStorage.setItem(storageKey,key);}
    if(!legacy&&action==='PROCESS_STORE_OCR_PHOTO'&&payload.image?.base64){
      const uploadKey=storageKey+'-photo';
      let photoId=sessionStorage.getItem(uploadKey);
      if(!photoId){photoId=await upload(payload.image,payload.uploadId);sessionStorage.setItem(uploadKey,photoId);}
      payload={...payload,photoId};delete payload.image;
    }
    if(legacy&&action==='processOCRWithGemini'){
      const image=Array.isArray(payload[0])?payload[0][0]:payload[0];
      const photoId=await upload({base64:String(image).replace(/^data:[^,]+,/,''),mimeType:'image/jpeg'});
      payload=[{photoId}];
    }
    const result=await request('/api/rpc','POST',{operation:legacy?'LEGACY_API':'PORTAL_API',action,payload},key);
    const final=result?.operationId&&result.awaitResult?await waitJob(result.operationId):result;
    if(final?.success!==false){sessionStorage.removeItem(storageKey);sessionStorage.removeItem(storageKey+'-photo');}
    return final;
  }
  function runner(success, failure){
    return new Proxy({}, {get(_, key){
      if(key==='withSuccessHandler')return fn=>runner(fn,failure);
      if(key==='withFailureHandler')return fn=>runner(success,fn);
      if(key==='then')return undefined;
      return (...args)=>{invoke(key,args).then(success||(()=>{}),failure||console.error);};
    }});
  }
  window.PortalNative={script:{get run(){return runner();}},request,waitJob};
})();
