# frozen_string_literal: true

require "bundler/setup"
require "chunky_png"
require "json"

request = JSON.parse($stdin.read)
image = ChunkyPNG::Image.from_file(request.fetch("image"))
results = request.fetch("regions").map do |region|
  left = region.fetch("x").floor
  top = region.fetch("y").floor
  right = (region.fetch("x") + region.fetch("width")).ceil
  bottom = (region.fetch("y") + region.fetch("height")).ceil
  unless left >= 0 && top >= 0 && right <= image.width && bottom <= image.height
    abort "Required text is outside the physical screenshot."
  end

  ink = 0
  (top...bottom).each do |y|
    (left...right).each do |x|
      color = image[x, y]
      if ChunkyPNG::Color.a(color).positive? && ChunkyPNG::Color.r(color) < 96 &&
          ChunkyPNG::Color.g(color) < 96 && ChunkyPNG::Color.b(color) < 96
        ink += 1
      end
    end
  end
  { text: region.fetch("text"), dark_pixels: ink }
end
puts JSON.generate(results)
