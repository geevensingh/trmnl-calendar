# frozen_string_literal: true

require "bundler/setup"
require "json"
require "yaml"
require "trmnl/liquid"

variables = JSON.parse($stdin.read)
environment = TRMNL::Liquid.new { |config| config.error_mode = :strict }
mode = ARGV.fetch(0)

markup =
  case mode
  when "full"
    File.read(File.join(__dir__, "src", "shared.liquid")) +
      File.read(File.join(__dir__, "src", "full.liquid"))
  when "polling-body"
    YAML.safe_load(File.read(File.join(__dir__, "src", "settings.yml"))).fetch("polling_body")
  else
    abort "Unsupported display mode."
  end

rendered = Liquid::Template.parse(markup, environment: environment)
  .render!(variables, strict_variables: true, strict_filters: true)

if mode == "full"
  puts <<~HTML
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=800, initial-scale=1">
        <link rel="stylesheet" href="/css/3.4.3/plugins.css">
        <script src="/js/3.4.3/plugins.js"></script>
        <style>body { margin: 0; }</style>
        <title>Synthetic calendar preview</title>
      </head>
      <body class="trmnl">
        <div class="screen screen--og screen--1bit">
          <div class="view view--full">#{rendered}</div>
        </div>
      </body>
    </html>
  HTML
else
  puts rendered
end
