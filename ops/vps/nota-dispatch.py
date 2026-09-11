#!/usr/bin/python3
import json, os, pathlib, sys, urllib.error, urllib.parse, urllib.request

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def main():
    cfg=json.loads((pathlib.Path(os.environ['CREDENTIALS_DIRECTORY'])/'dispatch.json').read_text())
    origin=cfg['origin'].rstrip('/')
    parsed=urllib.parse.urlsplit(origin)
    if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path:
        raise ValueError('INVALID_ORIGIN')
    if parsed.scheme!='https' and not (parsed.scheme=='http' and parsed.hostname in ('localhost','127.0.0.1','::1')):
        raise ValueError('HTTPS_REQUIRED')
    secret=cfg['secret']
    if len(secret)<32:raise ValueError('SECRET_NOT_CONFIGURED')
    request=urllib.request.Request(origin+'/api/internal/dispatch',headers={'Authorization':'Bearer '+secret},method='GET')
    with urllib.request.build_opener(NoRedirect).open(request,timeout=35) as response:
        body=json.loads(response.read(65536))
        if response.status!=200 or body.get('ok') is not True:raise ValueError('DISPATCH_FAILED')
    print('DISPATCH_OK')
if __name__=='__main__':
    try:main()
    except Exception as error:
        print('DISPATCH_FAILED: '+type(error).__name__,file=sys.stderr);sys.exit(1)
