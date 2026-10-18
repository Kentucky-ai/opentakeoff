"""Measure #538 against the working tree or --revision <git revision>."""
import argparse
import http.client
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import threading

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--revision')
args = parser.parse_args()
root = Path(__file__).resolve().parents[3]
with tempfile.TemporaryDirectory() as temporary:
    source = root / 'capture/capture_server.py'
    if args.revision:
        source = Path(temporary) / 'capture_server.py'
        source.write_bytes(subprocess.check_output(
            ['git', 'show', f'{args.revision}:capture/capture_server.py'], cwd=root))
    spec = importlib.util.spec_from_file_location('capture_server', source)
    capture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(capture)
    corpus = capture.Corpus(str(Path(temporary) / 'corpus'))
    server = capture.ThreadingHTTPServer(('127.0.0.1', 0), capture.make_handler(corpus))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    results = {}
    payload = {'schema': 'opentakeoff.contribution.v1', 'sheet_count': 1,
               'conditions': [{'finish': 'TEST-1'}],
               'shapes': [{'role': 'floor_area', 'finish': 'TEST-1', 'sheet': 'sheet_1',
                           'verts_norm': [[.1, .1], [.4, .1], [.4, .3], [.1, .3]],
                           'computed': {'sf': 10}}]}
    try:
        for method, path in [('GET', '/health'), ('OPTIONS', '/contribute'), ('POST', '/contribute')]:
            connection = http.client.HTTPConnection(*server.server_address, timeout=5)
            connection.request(method, path, json.dumps(payload) if method == 'POST' else None,
                               {'Origin': 'https://example.com', 'Content-Type': 'application/json'})
            response = connection.getresponse()
            response.read()
            results[method] = {'status': response.status,
                               'allow_origin': response.getheader('Access-Control-Allow-Origin'),
                               'allow_private_network': response.getheader('Access-Control-Allow-Private-Network')}
            connection.close()
        results['corpus_rows'] = corpus.summary()['rows']
        print(json.dumps(results, indent=2))
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
