"""
This little script converts SyxEx SDS samples for Elektron's Machinedrum UW to WAV files.
Usage: python sds2wav *.syx

Luciano Notarfrancesco, github.com/len
"""


import wave
import struct
import sys
import os

def read_7bits(f):
  data = list(f.read(1))
  return data[0]

def read_14bits(f):
  data = list(f.read(2))
  return data[0] + (data[1] << 7)

def read_20bits(f):
  data = list(f.read(3))
  return data[0] + (data[1] << 7) + (data[2] << 14)

def read_16bits(f):
  data = list(f.read(3))
  return ((data[0] << 9) | (data[1] << 2) | (data[2] >> 5)) - 0x8000

def convert_sds_to_wav(input_name, output_name):
  print(f'converting: {input_name} -> {output_name}')
  syx = open(input_name, 'rb')
  data = list(syx.read(2))
  if data != [0xf0, 0x7e]:
    raise Exception('wrong packet header')
  data = list(syx.read(2))
  if data != [0x00, 0x01]:
    print('wrong packet header (expected dump header)')
    sys.exit(1)
  sample_number = read_14bits(syx)
  print('reading sample number %d' % sample_number)
  sample_bit_depth = read_7bits(syx)
  if sample_bit_depth != 16:
    print('unexpected sample bit depth: %d' % sample_bit_depth)
    sys.exit(1)
  sample_period = float(read_20bits(syx))
  sample_rate = int(1000000000/sample_period + 1)
  if sample_rate != 44100:
    print('unexpected sample rate: %d' % sample_rate)
    sys.exit(1)
  waveform_length = read_20bits(syx)
  print('waveform length: %d' % waveform_length)
  loop_start = read_20bits(syx)
  loop_end = read_20bits(syx)
  loop_type = read_7bits(syx)
  if loop_type != 0x7f:
    print('loop from %d to %d, type %d' % (loop_start, loop_end, loop_type))
  data = list(syx.read(1))
  if data[0] != 0xf7:
    print('unexpected value at header end: %d' % data[0])
    sys.exit(1)

  syx.read(13) # skip 13 bytes

  wav = wave.open(output_name,'w')
  wav.setnchannels(1)
  wav.setsampwidth(2)
  wav.setframerate(44100.0)

  next_packet_number = 0

  remaining_samples = waveform_length

  while remaining_samples > 0:

    # read data packet:
    data = list(syx.read(2))
    if data != [0xf0, 0x7e]:
      print('wrong data packet header')
      sys.exit(1)
    data = list(syx.read(2))
    if data != [0x00, 0x02]:
      print('wrong packet header (expected data packet header)')
      sys.exit(1)
    packet_number = list(syx.read(1))[0]
    if packet_number != next_packet_number:
      print('expecting packet number %d got %d' % (next_packet_number, packet_number))
      sys.exit(1)
    next_packet_number = packet_number+1 & 0x7f

    samples = [read_16bits(syx) for i in range(40)]
    samples = samples[:min(remaining_samples,40)]

    for v in samples:
      wav.writeframes(struct.pack('<h', v))
      remaining_samples -= 1

    syx.read(2) # skip 2 bytes

  syx.close()
  wav.close()

if sys.argv[1] == '-d':
  for root, _, files in os.walk(sys.argv[2]):
    syx_files = [ x for x in files if x.endswith('.syx') ]
    for syx in syx_files:
      syx = os.path.join(root, syx)
      try:
        convert_sds_to_wav(syx, syx.replace('.syx', '.wav'))
      except:
        pass
else:
  input_file_names = sys.argv[1:]
  for each in sys.argv[1:]:
    if not each.endswith('.syx'):
      print('expected list of syx files to convert to wav')
      sys.exit(1)
    convert_sds_to_wav(each, each.replace('.syx', '.wav'))
