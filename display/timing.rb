# frozen_string_literal: true

require "json"
require "securerandom"
require "time"

module ValidationTiming
  SCRIPT_ENTRY = Process.clock_gettime(Process::CLOCK_MONOTONIC)

  def self.enabled?
    ENV.key?("TRMNL_TIMING_DIRECTORY")
  end

  def self.write(event)
    event[:operation_id] = ENV["TRMNL_TIMING_OPERATION_ID"]
    path = File.join(ENV.fetch("TRMNL_TIMING_DIRECTORY"), "phases-ruby-#{Process.pid}.jsonl")
    raise "Ruby timing report exceeds diagnostic limit." if File.exist?(path) && File.size(path) > 20 * 1024 * 1024

    File.open(path, "a") { |file| file.puts(JSON.generate(event)) }
  end

  def self.measure(phase)
    return yield unless enabled?

    id = SecureRandom.hex(16)
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    write(kind: "start", id: id, phase: phase, started_at: Time.now.utc.iso8601(6))
    passed = false
    begin
      value = yield
      passed = true
      value
    ensure
      write(kind: "end", id: id, phase: phase,
        duration_ms: (Process.clock_gettime(Process::CLOCK_MONOTONIC) - started) * 1000,
        result: passed || ($!.is_a?(SystemExit) && $!.success?) ? "passed" : "failed")
    end
  end

  def self.loaded!
    return unless enabled?

    id = SecureRandom.hex(16)
    origin = ENV["TRMNL_RUBY_STARTED_AT"]
    duration = origin ? (Time.now.utc - Time.iso8601(origin)) * 1000 :
      (Process.clock_gettime(Process::CLOCK_MONOTONIC) - SCRIPT_ENTRY) * 1000
    write(kind: "start", id: id, phase: "ruby.startup",
      origin: origin ? "parent process launch through dependency loading" : "script entry through dependency loading; interpreter unavailable")
    write(kind: "end", id: id, phase: "ruby.startup", duration_ms: duration, result: "passed")
  end
end
