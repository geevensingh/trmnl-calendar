# frozen_string_literal: true

require "bundler/setup"
require "chunky_png"
require "json"

request = JSON.parse($stdin.read)
directory = request.fetch("directory")

def save_png(directory, name, header, stream, transparency = nil)
  data = ChunkyPNG::Datastream.new
  data.header_chunk = header
  data.transparency_chunk = ChunkyPNG::Chunk::Transparency.new("tRNS", transparency) if transparency
  data.data_chunks = ChunkyPNG::Chunk::ImageData.split_in_chunks(stream)
  data.end_chunk = ChunkyPNG::Chunk::End.new
  File.binwrite(File.join(directory, "#{name}.png"), data.to_blob)
end

samples = [
  0x00000000, 0x00000001, 0x5f5f5fff, 0x606060ff,
  0x605f5fff, 0x5f605fff, 0x5f5f60ff, 0xffffffff,
  0x000102ff, 0x5f5f5f00, 0x000000ff, 0x0000007f
]
pixels = Array.new(64) { |index| samples[(index / 8 % 3) * 4 + index % 4] }
image = ChunkyPNG::Image.new(8, 8, pixels)
comparison = ChunkyPNG::Image.new(8, 8, pixels.each_with_index.map do |color, index|
  index.even? ? color ^ (index % 4 == 0 ? 0x01000000 : 1) : color
end)
5.times do |filter|
  [false, true].each do |interlace|
    options = { color_mode: ChunkyPNG::COLOR_TRUECOLOR_ALPHA, filtering: filter, interlace: interlace }
    name = "rgba-#{filter}-#{interlace}"
    image.save(File.join(directory, "#{name}.png"), options)
    comparison.save(File.join(directory, "#{name}-comparison.png"), options)
  end
end

{
  "rgb" => [ChunkyPNG::COLOR_TRUECOLOR, 8, [0x000000ff, 0x5f5f5fff, 0x606060ff, 0x605f5fff]],
  "gray" => [ChunkyPNG::COLOR_GRAYSCALE, 8, [0x000000ff, 0x5f5f5fff, 0x606060ff, 0xffffffff]],
  "gray-alpha" => [ChunkyPNG::COLOR_GRAYSCALE_ALPHA, 8, [0x00000000, 0x00000001, 0x5f5f5fff, 0x606060ff]],
  "gray-1" => [ChunkyPNG::COLOR_GRAYSCALE, 1, [0x000000ff, 0xffffffff, 0x000000ff, 0xffffffff]],
  "gray-2" => [ChunkyPNG::COLOR_GRAYSCALE, 2, [0x000000ff, 0x555555ff, 0xaaaaaaff, 0xffffffff]],
  "gray-4" => [ChunkyPNG::COLOR_GRAYSCALE, 4, [0x000000ff, 0x555555ff, 0x666666ff, 0xffffffff]],
  "indexed-1" => [ChunkyPNG::COLOR_INDEXED, 1, [0x00000000, 0x00000001, 0x00000000, 0x00000001]],
  "indexed-2" => [ChunkyPNG::COLOR_INDEXED, 2, [0x00000000, 0x00000001, 0x5f5f5fff, 0x606060ff]],
  "indexed-4" => [ChunkyPNG::COLOR_INDEXED, 4, [0x00000000, 0x00000001, 0x5f5f5fff, 0x606060ff]],
  "indexed-8" => [ChunkyPNG::COLOR_INDEXED, 8, [0x00000000, 0x00000001, 0x5f5f5fff, 0x606060ff]]
}.each do |name, (mode, depth, pixels)|
  ChunkyPNG::Image.new(8, 8, Array.new(64) { |index| pixels[index % 4] }).save(File.join(directory, "#{name}.png"),
    color_mode: mode, bit_depth: depth, filtering: ChunkyPNG::FILTER_PAETH, interlace: true)
end

# High and low bytes deliberately differ: the existing decoder keeps the high byte.
{ "gray-16" => 0, "rgb-16" => 2, "gray-alpha-16" => 4, "rgba-16" => 6 }.each do |name, mode|
  channels = { 0 => 1, 2 => 3, 4 => 2, 6 => 4 }.fetch(mode)
  stream = [0].pack("C") + [0x5fff, 0x6000, 0x0000, 0xffff].flat_map do |value|
    Array.new(channels) { |channel| [4, 6].include?(mode) && channel == channels - 1 ? 0x0100 : value }
  end.pack("n*")
  header = ChunkyPNG::Chunk::Header.new(width: 4, height: 1, color: mode, depth: 16)
  save_png(directory, name, header, stream)
end

{
  "gray-transparent" => [0, [95].pack("n"), [0, 0, 95, 96, 255].pack("C*")],
  "rgb-transparent" => [2, [95, 95, 95].pack("n*"), [0, 0, 0, 0, 95, 95, 95, 96, 96, 96, 255, 255, 255].pack("C*")]
}.each do |name, (mode, transparency, stream)|
  header = ChunkyPNG::Chunk::Header.new(width: 4, height: 1, color: mode, depth: 8)
  save_png(directory, name, header, stream, transparency)
end
{ "filter" => [5, 0, 0, 0, 255].pack("C*"), "short-scanline" => [0, 0].pack("C*") }.each do |name, stream|
  header = ChunkyPNG::Chunk::Header.new(width: 1, height: 1, color: 6, depth: 8)
  save_png(directory, name, header, stream)
end
puts JSON.generate(directory)
