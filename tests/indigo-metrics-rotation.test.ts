import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:https"
import { createServer as createHttpServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { TLSSocket } from "node:tls"

const binary = process.env.ALLOY_TEST_BINARY

test("pinned Alloy rejects an untrusted sink and reloads projected client certificates without restart", {skip: !binary, timeout: 90000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "indigo-alloy-rotation-"))
  const openssl = (...args: string[]) => execFileSync("openssl", args, {cwd: dir, stdio: "ignore"})
  const root = (name: string) => openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", `/CN=${name}`, "-keyout", `${name}.key`, "-out", `${name}.crt`)
  const issue = (name: string, purpose: string, serial: string) => {
    openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", `/CN=${name}`,
      "-keyout", `${name}.key`, "-out", `${name}.csr`)
    writeFileSync(join(dir, `${name}.ext`), `extendedKeyUsage=${purpose}\nsubjectAltName=DNS:${name}\n`)
    openssl("x509", "-req", "-in", `${name}.csr`, "-CA", "trusted.crt", "-CAkey", "trusted.key",
      "-set_serial", serial, "-days", "1", "-extfile", `${name}.ext`, "-out", `${name}.crt`)
  }
  let child: ReturnType<typeof spawn> | undefined
  let output = ""
  let sink: ReturnType<typeof createServer> | undefined
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  const until = async (check: () => boolean | Promise<boolean>, message: string) => {
    const deadline = Date.now() + 25000
    while (Date.now() < deadline) {
      if (await check()) return
      if (child?.exitCode !== null) throw new Error(`Alloy exited: ${output.slice(-3000)}`)
      await pause(250)
    }
    throw new Error(`${message}: ${output.slice(-3000)}`)
  }
  try {
    root("trusted")
    root("untrusted")
    issue("localhost", "serverAuth", "10")
    issue("client-one", "clientAuth", "11")
    issue("client-two", "clientAuth", "12")
    const seen = new Set<string>()
    sink = createServer({key: readFileSync(join(dir, "localhost.key")), cert: readFileSync(join(dir, "localhost.crt")),
      ca: readFileSync(join(dir, "trusted.crt")), requestCert: true, rejectUnauthorized: true}, (request, response) => {
      assert.equal(request.method, "POST")
      assert.equal(request.url, "/api/v1/write")
      const peer = request.socket as TLSSocket
      assert.equal(peer.authorized, true)
      request.resume()
      request.on("end", () => {
        seen.add(peer.getPeerCertificate().subject.CN)
        response.writeHead(204).end()
      })
    })
    sink.listen(0, "127.0.0.1")
    await once(sink, "listening")
    const sinkPort = (sink.address() as {port: number}).port
    const probe = createHttpServer()
    probe.listen(0, "127.0.0.1")
    await once(probe, "listening")
    const alloyPort = (probe.address() as {port: number}).port
    await new Promise<void>(resolve => probe.close(() => resolve()))

    for (const [generation, client, ca] of [["initial", "client-one", "untrusted"],
      ["trusted-first", "client-one", "trusted"], ["rotated", "client-two", "trusted"]]) {
      mkdirSync(join(dir, generation))
      writeFileSync(join(dir, generation, "tls.crt"), readFileSync(join(dir, `${client}.crt`)))
      writeFileSync(join(dir, generation, "tls.key"), readFileSync(join(dir, `${client}.key`)), {mode: 0o600})
      writeFileSync(join(dir, generation, "ca.crt"), readFileSync(join(dir, `${ca}.crt`)))
    }
    symlinkSync(join(dir, "initial"), join(dir, "mounted"))
    const swap = (generation: string) => {
      symlinkSync(join(dir, generation), join(dir, "next"))
      renameSync(join(dir, "next"), join(dir, "mounted"))
    }
    // Exercise the actual production TLS/file/remote-write blocks with only
    // fixture paths and endpoint changed. No real credentials.
    let config = readFileSync("gitops/components/telemetry-metrics/overlays/indigo/config.alloy", "utf8")
      .split("// Explicit inventory:")[0]
      .replaceAll("/etc/telemetry/ca", join(dir, "mounted"))
      .replaceAll("/etc/telemetry/tls", join(dir, "mounted"))
      .replaceAll("beacon-telemetry.service.home.arpa:9443", `localhost:${sinkPort}`)
      .replaceAll('server_name = "beacon-telemetry.service.home.arpa"', 'server_name = "localhost"')
    config += `\nprometheus.exporter.self "fixture" {}\nprometheus.scrape "fixture" {
      targets = prometheus.exporter.self.fixture.targets
      scrape_interval = "1s"
      scrape_timeout = "1s"
      forward_to = [prometheus.remote_write.beacon.receiver]
    }\n`
    const filename = join(dir, "config.alloy")
    writeFileSync(filename, config)
    execFileSync(binary!, ["validate", filename], {stdio: "pipe"})
    child = spawn(binary!, ["run", "--disable-reporting", `--server.http.listen-addr=127.0.0.1:${alloyPort}`,
      `--storage.path=${join(dir, "wal")}`, filename], {stdio: ["ignore", "pipe", "pipe"]})
    child.on("error", e => { output += String(e) })
    child.stdout?.on("data", b => { output = (output + b).slice(-12000) })
    child.stderr?.on("data", b => { output = (output + b).slice(-12000) })
    const pid = child.pid
    await until(() => /certificate|unknown authority/i.test(output), "expected TLS trust rejection")
    assert.equal(seen.size, 0, "must not send samples to an untrusted server")
    swap("trusted-first")
    await until(() => seen.has("client-one"), "first trusted certificate did not send metrics")
    swap("rotated")
    await until(() => seen.has("client-two"), "rotated certificate did not send metrics")
    assert.equal(child.pid, pid)
    assert.equal(child.exitCode, null)
    assert.doesNotMatch(output, /Stopping remote storage/, "certificate rotation must not rebuild the remote-write queue")
  } finally {
    if (child && child.exitCode === null) {
      const exited = once(child, "exit")
      child.kill("SIGTERM")
      const timer = setTimeout(() => child?.kill("SIGKILL"), 4000)
      await exited
      clearTimeout(timer)
    }
    if (sink) {
      sink.closeAllConnections()
      await new Promise<void>(resolve => sink!.close(() => resolve()))
    }
    // Only this test's freshly created directory; it contains fixture keys.
    rmSync(dir, {recursive: true, force: true})
  }
})
