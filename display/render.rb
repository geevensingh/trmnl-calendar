# frozen_string_literal: true

require "bundler/setup"
require "json"
require "yaml"
require "trmnl/liquid"

variables = JSON.parse($stdin.read)
environment = TRMNL::Liquid.new { |config| config.error_mode = :strict }
mode = ARGV.fetch(0)
views = %w[full half_horizontal half_vertical]

markup =
  case mode
  when *views
    File.read(File.join(__dir__, "src", "shared.liquid")) +
      File.read(File.join(__dir__, "src", "#{mode}.liquid"))
  when "polling-body"
    YAML.safe_load(File.read(File.join(__dir__, "src", "settings.yml"))).fetch("polling_body")
  else
    abort "Unsupported display mode."
  end

rendered = Liquid::Template.parse(markup, environment: environment)
  .render!(variables, strict_variables: true, strict_filters: true)

if views.include?(mode)
  device = ARGV.fetch(1, "og")
  width = { "og" => 800, "v2" => 1872 }.fetch(device) { abort "Unsupported preview device." }
  view = %(<div class="view view--#{mode}">#{rendered}</div>)
  if mode != "full"
    arrangement = mode == "half_horizontal" ? "1Tx1B" : "1Lx1R"
    view = %(<div class="mashup mashup--#{arrangement}">#{view}<div class="view view--#{mode}" aria-hidden="true"></div></div>)
  end
  puts <<~HTML
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=#{width}, initial-scale=1">
        <link rel="stylesheet" href="/css/3.4.3/plugins.css">
        <script src="/js/3.4.3/plugins.js"></script>
        <style>body { margin: 0; }</style>
        <title>Synthetic calendar preview</title>
      </head>
      <body class="trmnl">
        <div class="screen screen--#{device} screen--#{device == "og" ? "1bit" : "4bit"}">
          #{view}
        </div>
      </body>
    </html>
  HTML
else
  puts rendered
end
