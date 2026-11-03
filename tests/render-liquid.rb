# frozen_string_literal: true

require_relative "../display/timing"
ValidationTiming.measure("ruby.load") do
  require "bundler/setup"
  require "json"
  require "trmnl/liquid"
end
ValidationTiming.loaded!

root = File.expand_path("../display/src", __dir__)
placement = ARGV.fetch(0)
abort "Unsupported placement." unless %w[full half_horizontal half_vertical].include?(placement)
markup = File.read(File.join(root, "shared.liquid")) +
  File.read(File.join(root, "#{placement}.liquid"))
environment = TRMNL::Liquid.new { |config| config.error_mode = :strict }
puts ValidationTiming.measure("ruby.render") {
  Liquid::Template.parse(markup, environment: environment)
    .render!(JSON.parse($stdin.read), strict_variables: true, strict_filters: true)
}
