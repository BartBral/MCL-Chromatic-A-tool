import wave
import struct
import sys
import os

def to_21bit_3bytes(val):
    """Standard SDS 3-byte little-endian (7-bit chunks)."""
    lo = val & 0x7F
    mi = (val >> 7) & 0x7F
    hi = (val >> 14) & 0x7F
    return lo, mi, hi

def get_wav_loop_points(wav_path):
    """
    Manually parses the WAV file to find the 'smpl' chunk 
    and extract the first loop's start and end points.
    """
    try:
        with open(wav_path, 'rb') as f:
            data = f.read()
            # Find the 'smpl' chunk marker
            smpl_idx = data.find(b'smpl')
            if smpl_idx == -1:
                return None, None

            # The 'smpl' chunk structure:
            # Offset 36 (from 'smpl' start) is the number of sample loops
            num_loops = struct.unpack('<I', data[smpl_idx + 36 : smpl_idx + 40])[0]
            
            if num_loops > 0:
                # The first loop record starts at offset 44
                # Within that record: 
                # Start point is at offset 8, End point at offset 12
                l_start_idx = smpl_idx + 44 + 8
                l_end_idx = smpl_idx + 44 + 12
                
                loop_start = struct.unpack('<I', data[l_start_idx : l_start_idx + 4])[0]
                loop_end = struct.unpack('<I', data[l_end_idx : l_end_idx + 4])[0]
                return loop_start, loop_end
    except Exception as e:
        print(f"Metadata Error: Could not parse smpl chunk: {e}")
    
    return None, None

def create_sds_sysex(
    wav_path,
    output_syx_path,
    device_id=0x00,
    md_name="SMPL",
    loop_start=None,
    loop_end=None,
):
    # Try to auto-detect loop points if not provided via command line
    if loop_start is None or loop_end is None:
        detected_start, detected_end = get_wav_loop_points(wav_path)
        if detected_start is not None:
            loop_start = detected_start
            loop_end = detected_end

    md_name = (md_name[:4]).upper().ljust(4, " ")
    name_bytes = [ord(c) for c in md_name]

    with wave.open(wav_path, "rb") as wav:
        framerate = wav.getframerate()
        n_frames = wav.getnframes()
        n_channels = wav.getnchannels()
        sampwidth = wav.getsampwidth()
        frames = wav.readframes(n_frames)

        if n_channels == 0 or sampwidth == 0 or len(frames) == 0:
            raise ValueError("Empty or corrupt WAV")

        actual_frames = len(frames) // (n_channels * sampwidth)

        # Convert to 16-bit signed mono
        if sampwidth == 1:
            raw = struct.unpack(f"{len(frames)}B", frames)
            samples = [(raw[i * n_channels] - 128) << 8 for i in range(actual_frames)]
        elif sampwidth == 2:
            raw = struct.unpack(f"<{actual_frames * n_channels}h", frames)
            samples = [raw[i * n_channels] for i in range(actual_frames)]
        else:
            raise ValueError("Only 8- or 16-bit supported")

    total_samples = len(samples)
    l, m, h = to_21bit_3bytes(total_samples)
    period_ns = int(1000000000 // framerate)
    pl, pm, ph = to_21bit_3bytes(period_ns)

    if loop_start is not None and loop_end is not None:
        ls, lm, lh = to_21bit_3bytes(int(loop_start))
        es, em, eh = to_21bit_3bytes(int(loop_end))
        loop_type = 0x00 # Forward
    else:
        ls = lm = lh = es = em = eh = 0
        loop_type = 0x7F # Off

    with open(output_syx_path, "wb") as f:
        # 1. DUMP HEADER
        header = [
            0xF0, 0x7E, device_id, 0x01, 0x00, 0x00, 0x10,
            pl, pm, ph,
            l, m, h,
            ls, lm, lh,
            es, em, eh,
            loop_type,
            0xF7
        ]
        f.write(bytearray(header))

        # 2. DATA PACKETS
        packet_num = 0
        for i in range(0, total_samples, 40):
            chunk = samples[i : i + 40]
            curr_id = packet_num & 0x7F
            payload = []
            for s in chunk:
                u16 = (s + 32768) & 0xFFFF
                b0 = (u16 >> 0) & 0x03
                b1 = (u16 >> 2) & 0x7F
                b2 = (u16 >> 9) & 0x7F
                payload.extend([b2, b1, b0])

            while len(payload) < 120:
                payload.append(0x00)

            checksum = 0x7E ^ device_id ^ 0x02 ^ curr_id
            for b in payload:
                checksum ^= b
            
            packet = [0xF0, 0x7E, device_id, 0x02, curr_id] + payload + [checksum & 0x7F, 0xF7]
            f.write(bytearray(packet))
            packet_num = (packet_num + 1) & 0x7F

        # 3. NAME MESSAGE (MD-UW style)
        name_msg = [0xF0, 0x00, 0x20, 0x3C, 0x02, device_id, 0x73, 0x00] + name_bytes + [0xF7]
        f.write(bytearray(name_msg))
    
    return loop_start, loop_end

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 convert.py <file.wav> [loop_start] [loop_end] [device_id]")
        sys.exit(1)

    wav_in = sys.argv[1]
    l_start = int(sys.argv[2]) if len(sys.argv) >= 3 and sys.argv[2].strip() else None
    l_end = int(sys.argv[3]) if len(sys.argv) >= 4 and sys.argv[3].strip() else None
    dev_id = int(sys.argv[4], 0) if len(sys.argv) >= 5 else 0x00

    out_name = os.path.splitext(wav_in)[0] + ".syx"
    base_name = os.path.basename(wav_in)[:4]

    final_start, final_end = create_sds_sysex(
        wav_in, out_name, device_id=dev_id, md_name=base_name, loop_start=l_start, loop_end=l_end
    )

    print(f"Success: {out_name}")
    if final_start is not None:
        print(f"Loop set: {final_start} to {final_end}")
    else:
        print("No loop points found.")
