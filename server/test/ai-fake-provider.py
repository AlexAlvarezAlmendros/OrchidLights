#!/usr/bin/env python3
"""Un proveedor de IA falso para ai-smoke.sh: contesta como Anthropic y como
OpenAI, y apunta en un fichero cada petición que le llega -- ruta, cabeceras y
cuerpo -- para que el test compruebe qué dejó pasar el proxy y qué no.

    ai-fake-provider.py <puerto> <fichero-de-registro>

El cuerpo decide la respuesta, porque el proxy no deja pasar cabeceras de
control: "stream": true contesta con eventos cada 300 ms, y un mensaje que dice
"slow" alarga el stream para que haya tiempo de cortarlo a medias.

Y una petición que trae "tools" es el asistente de la web: entonces hace de
modelo con un guion, en el formato de streaming de Anthropic -- mira el
proyecto, aplica un documento y termina --, para que ai-ui-smoke.sh pruebe la
cadena entera sin gastar un token.
"""

import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1])
LOG = sys.argv[2]
GOOD_KEY = "sk-test-good-key-1234"


def record(entry):
    with open(LOG, "a") as log:
        log.write(json.dumps(entry) + "\n")


def sse(name, data):
    chunk = f"event: {name}\ndata: {json.dumps(data)}\n\n".encode()
    return b"%x\r\n%s\r\n" % (len(chunk), chunk)


# El documento que el «modelo» aplica: un dímer genérico y una escena sobre él.
GUION_DOCUMENTO = {
    "orchidlights": 1,
    "fixtures": [{"name": "Sala IA", "manufacturer": "Generic", "model": "Generic",
                  "mode": "1 Channel", "universe": 1, "address": 500}],
    "functions": [{"name": "Prueba del asistente", "type": "Scene", "path": "Asistente",
                   "values": [{"fixture": "Sala IA", "channel": 0, "value": 200}]}],
}


def guion(body):
    """Qué contesta el modelo de mentira según lo que ya le han devuelto."""
    resultados = [
        block for message in body.get("messages", []) if message.get("role") == "user"
        and isinstance(message.get("content"), list)
        for block in message["content"] if block.get("type") == "tool_result"
    ]
    if not resultados:
        return "Miro el proyecto.", ("toolu_1", "ver_proyecto", {})
    if len(resultados) == 1:
        return "Creo la escena.", ("toolu_2", "aplicar", {"documento": GUION_DOCUMENTO})
    return "Hecho: una escena nueva.", None


class Provider(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("request-id", "req_fake")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        headers = {k.lower(): v for k, v in self.headers.items()}
        record({"method": "GET", "path": self.path, "headers": headers})

        if self.path.startswith("/v1/models"):
            if headers.get("x-api-key") != GOOD_KEY:
                return self.reply(401, {"type": "error", "error": {
                    "type": "authentication_error", "message": "invalid x-api-key"}})
            return self.reply(200, {"data": [{"id": "claude-opus-5-5"}, {"id": "claude-haiku-5-5"}]})

        if self.path == "/models":
            return self.reply(200, {"data": [{"id": "llama3"}, {"id": "qwen"}]})

        self.reply(404, {"error": "no such route"})

    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        headers = {k.lower(): v for k, v in self.headers.items()}
        record({"method": "POST", "path": self.path, "headers": headers, "body": body})

        if self.path == "/chat/completions":
            return self.reply(200, {
                "choices": [{"message": {"role": "assistant", "content": "hola"}}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 2},
            })

        if self.path != "/v1/messages":
            return self.reply(404, {"error": "no such route"})

        if body.get("tools"):
            return self.scripted(body)

        if not body.get("stream"):
            return self.reply(200, {
                "type": "message",
                "content": [{"type": "text", "text": "hola"}],
                "usage": {"input_tokens": 11, "output_tokens": 7},
            })

        slow = "slow" in json.dumps(body.get("messages", []))
        events = [("message_start", {"type": "message_start", "message": {
            "usage": {"input_tokens": 20, "cache_read_input_tokens": 5, "output_tokens": 1}}})]
        for i in range(40 if slow else 3):
            events.append(("content_block_delta", {"type": "content_block_delta", "index": i}))
        events.append(("message_delta", {"type": "message_delta", "usage": {"output_tokens": 9}}))
        events.append(("message_stop", {"type": "message_stop"}))

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        try:
            for name, data in events:
                chunk = f"event: {name}\ndata: {json.dumps(data)}\n\n".encode()
                self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
                self.wfile.flush()
                time.sleep(0.3)
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            record({"event": "client closed", "path": self.path})

    def scripted(self, body):
        texto, herramienta = guion(body)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        out = [sse("message_start", {"type": "message_start", "message": {
            "id": "msg_fake", "type": "message", "role": "assistant", "model": body.get("model"),
            "content": [], "stop_reason": None, "stop_sequence": None,
            "usage": {"input_tokens": 1000, "output_tokens": 1}}})]
        out.append(sse("content_block_start", {"type": "content_block_start", "index": 0,
                                               "content_block": {"type": "text", "text": ""}}))
        out.append(sse("content_block_delta", {"type": "content_block_delta", "index": 0,
                                               "delta": {"type": "text_delta", "text": texto}}))
        out.append(sse("content_block_stop", {"type": "content_block_stop", "index": 0}))
        if herramienta:
            ident, nombre, entrada = herramienta
            out.append(sse("content_block_start", {"type": "content_block_start", "index": 1,
                "content_block": {"type": "tool_use", "id": ident, "name": nombre, "input": {}}}))
            out.append(sse("content_block_delta", {"type": "content_block_delta", "index": 1,
                "delta": {"type": "input_json_delta", "partial_json": json.dumps(entrada)}}))
            out.append(sse("content_block_stop", {"type": "content_block_stop", "index": 1}))
        out.append(sse("message_delta", {"type": "message_delta",
            "delta": {"stop_reason": "tool_use" if herramienta else "end_turn", "stop_sequence": None},
            "usage": {"output_tokens": 50}}))
        out.append(sse("message_stop", {"type": "message_stop"}))
        for chunk in out:
            self.wfile.write(chunk)
            self.wfile.flush()
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()

ThreadingHTTPServer(("127.0.0.1", PORT), Provider).serve_forever()
