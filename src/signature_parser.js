import {
    buffer_to_utf8,
    utf8_to_buffer,
    utf8_encoded_length,
  } from './utf8.js';

export const
  BOOLEAN = 0,
  UINT8 = 1,
  UINT16 = 2,
  UINT32 = 3,
  UINT64 = 4,
  INT8 = 5,
  INT16 = 6,
  INT32 = 7,
  INT64 = 8,
  FLOAT32 = 9,
  FLOAT64 = 10,
  BLOB = 11,
  BLOB16 = 12,
  REST = 13,
  STRING = 15,
  BITSTRING = 16;

const PT_BITSTRINGFIXED = 17,
      PT_BLOBFIXED = 14,
      PT_MAP = 18,
      PT_LIST = 19,
      PT_LIST2D = 20,
      PT_LISTFIXED = 21,
      PT_CUSTOM = 22;

export class Arguments
{
 constructor(values)
 {
   this.values = values;
 }

 item(n)
 {
   return this.values[n];
 }
}

function utf8_codepoint_length(buf, pos, codepoints) {
  var tmp = pos;

  /* From table 3-6 in the Unicode standard 4.0: Well-Formed UTF-8
   * Byte Sequences
   *
   *  Code Points   1st Byte  2nd Byte  3rd Byte  4th Byte
   * 000000-00007f   00-7f
   * 000080-0007ff   c2-df     80-bf
   * 000800-000fff    e0       a0-bf     80-bf
   * 001000-00cfff   e1-ec     80-bf     80-bf
   * 00d000-00d7ff    ed       80-9f     80-bf
   * 00e000-00ffff   ee-ef     80-bf     80-bf
   * 010000-03ffff    f0       90-bf     80-bf     80-bf
   * 040000-0fffff   f1-f3     80-bf     80-bf     80-bf
   * 100000-10ffff    f4       80-8f     80-bf     80-bf
   */

  while (codepoints--) {
    var c = buf.getUint8(pos);
    pos ++;
    if (c <= 0x7f) continue;
    pos ++;
    if (c <= 0xdf) continue;
    pos ++;
    if (c <= 0xef) continue;
    pos ++;
  }

  return pos - tmp;
}

function memcpy(dst, src, len) {
  var i;
  for (i = 0; i < len; i++) {
    dst[i] = src[i];
  }
}

export class encoder
{
  constructor(signature, data)
  {
     this.signature = signature;
     this.data = data;
     this.length = signature.length;
     this.byteLength = signature.low_encoded_length(data);
  }

  encode_to(dst, pos) {
    pos = pos|0;
    return this.signature.do_encode(dst, pos, this.data, 0);
  }
}

function make_signature(o) {
  if (o instanceof signature) return o;
  return new signature(o);
}

function low_decode_bitstring(data, pos, len) {
  var tmp = new Array(len);
  var blen = (len + 7) >> 3;
  var abuf = new Uint8Array(data.buffer, data.byteOffset+pos, blen);
  for (var k = 0; k < len; k++) {
    tmp[k] = !!(abuf[ k >> 3 ] & (128 >> (k & 7)));
  }
  return tmp;
}

function low_encode_bitstring(dst, pos, from) {
  var len = from.length;
  var blen = (len+7)>>3;
  var abuf = new Uint8Array(dst.buffer, dst.byteOffset+pos, blen);
  var k, tmp, j, i;

  for (i = j = 0; j < blen; j++) {
    tmp = 0;

    for (k = 0; k < 8 && i < len; k++, i++) {
      if (from[i]) {
        tmp |= 128 >> k;
      }
    }

    abuf[j] = tmp;
  }

  pos += blen;
  return pos;
}

export class signature
{
  constructor(...args)
  {
    var num_basic = 0,
        num_custom = 0;

    var type, i;

    for (i = 0; i < args.length; i++) {
      switch (typeof(args[i])) {
      case "number":
        if ((args[i]|0) !== args[i] ||
            args[i] < BOOLEAN || args[i] > PT_CUSTOM)
              throw("Bad argument. Expected signature type.");
        break;
      case "function":
        num_custom++;
        break;
      case "object":
        num_custom++;
        break;
      default:
        throw new Error("Bad argument: " + typeof(args[i]));
      }
    }

    var C, S, O;

    this.custom = C = num_custom ? new Array(num_custom) : null;
    this.signatures = O = num_custom ? new Array(num_custom) : null;
    this.signature = S = new Uint8Array(args.length);

    num_custom = 0;

    for (i = 0; i < args.length; i++) {
      switch (typeof(args[i])) {
      case "number":
        S[i] = args[i];
        break;
      case "function":
        S[i] = PT_CUSTOM;
        C[num_custom] = args[i];
        O[num_custom] = args[i].signature;
        num_custom++;
        break;
      case "object":
        {
          var a = args[i];
          if (a instanceof Array) {
            switch (a[0]) {
            case PT_LIST:
            case PT_LIST2D:
              O[num_custom] = make_signature(a[1]);
              break;
            case PT_MAP:
              O[num_custom] = new signature(a[1], a[2]);
              break;
            case PT_LISTFIXED:
              C[num_custom] = a[1];
              O[num_custom] = make_signature(a[2]);
              break;
            case PT_BLOBFIXED:
            case PT_BITSTRINGFIXED:
              C[num_custom] = a[1];
              break;
            default:
              throw("Unsupported complex type.");
              break;
            }
            S[i] = a[0];
            num_custom++;
          } else {
            throw("Unsupported argument.");
          }
        }
        break;
      }
    }

    this.length = S.length;
    this._length = 0;
    try { this._length = this.encoded_length(); } catch(e) {};
  }

  do_decode(data, pos, dst, dst_pos)
  {
    var S = this.signature;
    var C = this.custom;
    var O = this.signatures;
    var i, len, tmp, j;
    var num_custom;

    for (i = 0, num_custom = 0; i < S.length; i++, dst_pos++) {
      switch (S[i]) {
      case BOOLEAN:
        dst[dst_pos] = data.getUint8(pos) === 1;
        pos += 1;
        break;
      case UINT8:
        dst[dst_pos] = data.getUint8(pos);
        pos += 1;
        break;
      case UINT16:
        dst[dst_pos] = data.getUint16(pos);
        pos += 2;
        break;
      case UINT32: 
        dst[dst_pos] = data.getUint32(pos);
        pos += 4;
        break;
      case UINT64: 
        {
          const hi = data.getUint32(pos);
          pos += 4;
          const lo = data.getUint32(pos);
          pos += 4;

          if (hi > (1 << 20))
          {
            dst[dst_pos] = { hi: hi, lo: lo };
          }
          else
          {
            dst[dst_pos] = lo + Math.pow(2, 32) * hi;
          }
          break;
        }
      case INT8: 
        dst[dst_pos] = data.getInt8(pos);
        pos += 1;
        break;
      case INT16: 
        dst[dst_pos] = data.getInt16(pos);
        pos += 2;
        break;
      case INT32: 
        dst[dst_pos] = data.getInt32(pos);
        pos += 4;
        break;
      case INT64: 
        {
          const tmp = data.getUint32(pos);
          const hi = tmp & 0x7fffffff;
          const sgn = !!(tmp & 0x80000000);
          pos += 4;
          const lo = data.getUint32(pos);
          pos += 4;

          if (hi > (1 << 20))
          {
            dst[dst_pos] = { sgn: sgn, hi: hi, log: lo };
          }
          else
          {
            dst[dst_pos] = (lo + Math.pow(2, 32) * hi) * (sgn ? -1 : 1);
          }
          break;
        }
        break;
      case FLOAT32: 
        dst[dst_pos] = data.getFloat32(pos);
        pos += 4;
        break;
      case FLOAT64: 
        dst[dst_pos] = data.getFloat64(pos);
        pos += 8;
        break;
      case BLOB:
        {
          len = data.getUint16(pos);
          pos += 2;
          dst[dst_pos] = data.buffer.slice(data.byteOffset+pos, data.byteOffset+pos+len);
          pos += len;
        }
        break;
      case BLOB16:
        {
          len = data.getUint16(pos);
          pos += 2;
          tmp = new Array(len);
          for (j = 0; j < len; j++) {
            tmp[j] = data.getUint16(pos);
            pos += 2;
          }
          dst[dst_pos] = String.fromCharCode.apply(String, tmp);
        }
        break;
      case REST:
        dst[dst_pos] = data.buffer.slice(data.byteOffset+pos);
        break;
      case PT_BLOBFIXED:
        {
          len = C[num_custom++];
          dst[dst_pos] = data.buffer.slice(data.byteOffset+pos, data.byteOffset+pos+len);
          pos += len;
        }
        break;
      case STRING:
        {
          var abuf, k;
          /* this is the number of code points */
          k = data.getUint16(pos);
          pos += 2;
          /* this is the length of the data */
          len = utf8_codepoint_length(data, pos, k);
          abuf = new Uint8Array(data.buffer, data.byteOffset+pos, len);
          pos += len;
          dst[dst_pos] = buffer_to_utf8(abuf);
        }
        break;
      case BITSTRING:
        {
          var k;
          len = data.getUint16(pos);
          pos += 2;
          dst[dst_pos] = low_decode_bitstring(data, pos, len);
          pos += (len + 7)>>3;
        }
        break;
      case PT_BITSTRINGFIXED:
        {
          var k;
          len = C[num_custom++];
          dst[dst_pos] = low_decode_bitstring(data, pos, len);
          pos += (len+7)>>3;
        }
        break;
      case PT_MAP: 
        dst[dst_pos] = new Map();
        tmp = new Array(2);
        len = data.getUint16(pos);
        pos += 2;
        for (j = 0; j < len; j++) {
          pos = O[num_custom].do_decode(data, pos, tmp, 0);
          dst[dst_pos].set(tmp[0], tmp[1]);
        }
        num_custom++;
        break;
      case PT_LIST: 
        len = data.getUint16(pos);
        pos += 2;
        tmp = new Array(len);
        for (j = 0; j < len; j++)
              pos = O[num_custom].do_decode(data, pos, tmp, j);
        dst[dst_pos] = tmp;
        num_custom++;
        break;
      case PT_LIST2D: 
        {
          const X = data.getUint16(pos);
          pos += 2;
          const Y = data.getUint16(pos);
          pos += 2;
          const custom = O[num_custom];

          const res = new Array(Y);

          for (let i = 0; i < Y; i++)
          {
            const tmp = new Array(X);

            for (let j = 0; j < X; j++)
            {
              pos = custom.do_decode(data, pos, tmp, j);
            }

            res[i] = tmp;
          }

          dst[dst_pos] = res;
          num_custom++;
          break;
        }
      case PT_LISTFIXED: 
        len = C[num_custom++];
        tmp = new Array(len);
        for (j = 0; j < len; j++)
              pos = O[num_custom].do_decode(data, pos, tmp, j);
        dst[dst_pos] = tmp;
        break;
      case PT_CUSTOM:
        tmp = [];
        pos = O[num_custom].do_decode(data, pos, tmp, 0);
        dst[dst_pos] = new C[num_custom](...tmp);
        num_custom++;
        break;
      }
    }

    return pos;
  }

  decode(data)
  {
    var ret = new Array(this.length);

    this.do_decode(data, 0, ret, 0);

    if (this.length === 1) return ret[0];

    return new Arguments(ret);
  }

  low_decode(data)
  {
    var ret = new Array(this.length);

    this.do_decode(data, 0, ret, 0);

    return ret;
  }

  encoder(src)
  {
    return new encoder(this, src);
  }

  do_encode(dst, pos, src, src_pos) {
    var S = this.signature;
    var C = this.custom;
    var O = this.signatures;
    var len, num_custom, j, i;

    for (i = 0, num_custom = 0; i < S.length; i++, src_pos++) {
      switch (S[i])
      {
      case BOOLEAN:
        dst.setUint8(pos, src[src_pos] ? 1 : 0);
        pos += 1;
        break;
      case UINT8:
        dst.setUint8(pos, src[src_pos]);
        pos += 1;
        break;
      case UINT16:
        dst.setUint16(pos, src[src_pos]);
        pos += 2;
        break;
      case UINT32: 
        dst.setUint32(pos, src[src_pos]);
        pos += 4;
        break;
      case UINT64: 
        {
          const val = src[src_pos];

          if (typeof val === 'number')
          {
            if (val < 0)
              throw new Error('Bad argument, expected positive number.');
            const hi = val / 0xffffffff;

            dst.setUint32(pos, hi);
            pos += 4;
            dst.setUint32(pos, val);
            pos += 4;
          }
          else if (typeof val === 'object')
          {
            dst.setUint32(pos, val.hi);
            pos += 4;
            dst.setUint32(pos, val.lo);
            pos += 4;
          }
          else throw new Error('Bad argument, expected number or Object.');

          break;
        }
      case INT8: 
        dst.setInt8(pos, src[src_pos]);
        pos += 1;
        break;
      case INT16: 
        dst.setInt16(pos, src[src_pos]);
        pos += 2;
        break;
      case INT32: 
        dst.setInt32(pos, src[src_pos]);
        pos += 4;
        break;
      case INT64: 
        {
          let val = src[src_pos];

          if (typeof val === 'number')
          {
            const sgn = val < 0;

            if (sgn) val = -val;

            let hi = val / 0xffffffff;
            const lo = val - hi * 0xffffffff

            if (sgn) hi |= 0x80000000;

            dst.setUint32(pos, hi);
            pos += 4;
            dst.setUint32(pos, val);
            pos += 4;
          }
          else if (typeof val === 'object')
          {
            const hi = val.hi | (val.sgn ? 0x80000000 : 0);
            dst.setUint32(pos, hi);
            pos += 4;
            dst.setUint32(pos, val.lo);
            pos += 4;
          }
          else throw new Error('Bad argument, expected number or Object.');

          break;
        }
      case FLOAT32: 
        dst.setFloat32(pos, src[src_pos]);
        pos += 4;
        break;
      case FLOAT64: 
        dst.setFloat64(pos, src[src_pos]);
        pos += 8;
        break;
      case BLOB:
        {
          len = src[src_pos].byteLength;
          dst.setUint16(pos, len);
          pos += 2;
          memcpy(new Uint8Array(dst.buffer, dst.byteOffset+pos, len),
                 new Uint8Array(src[src_pos], 0, len),
                 len);
          pos += len;
        }
        break;
      case BLOB16:
        {
          len = src[src_pos].length;
          dst.setUint16(pos, len);
          pos += 2;
          for (j = 0; j < len; i++) {
            dst.setUint16(pos, src[src_pos].charCodeAt(j));
            pos += 2;
          }
        }
        break;
      case REST:
        ret[i] = data.buffer.slice(data.byteOffset+pos);
        break;
      case PT_BLOBFIXED:
        {
          len = C[num_custom];
          memcpy(new Uint8Array(dst.buffer, dst.byteOffset+pos, len),
                 new Uint8Array(src[src_pos], 0, len),
                 len);
          pos += len;
        }
        num_custom++;
        break;
      case STRING:
        {
          var len = src[src_pos].length;
          dst.setUint16(pos, len);
          pos += 2;
          var abuf = utf8_to_buffer(src[src_pos]);
          len = abuf.byteLength;

          memcpy(new Uint8Array(dst.buffer, dst.byteOffset+pos, len),
                 new Uint8Array(abuf),
                 len);

          pos += len;
        }
        break;
      case BITSTRING:
        {
          var len = src[src_pos].length;
          dst.setUint16(pos, len);
          pos += 2;
          pos = low_encode_bitstring(dst, pos, src[src_pos]);
        }
        break;
      case PT_BITSTRINGFIXED:
        {
          num_custom++;
          pos = low_encode_bitstring(dst, pos, src[src_pos]);
        }
        break;
      case PT_MAP: 
        len = src[src_pos].size;
        dst.setUint16(pos, len);
        pos += 2;
        for (j of src[src_pos]) {
          pos = O[num_custom].do_encode(dst, pos, j, 0);
        }
        num_custom++;
        break;
      case PT_LIST: 
        len = src[src_pos].length;
        dst.setUint16(pos, len);
        pos += 2;
        for (j = 0; j < len; j++) {
          pos = O[num_custom].do_encode(dst, pos, src[src_pos], j);
        }
        num_custom++;
        break;
      case PT_LISTFIXED: 
        len = src[src_pos].length;
        if (len != C[num_custom]) throw("Length mismatch.");
        for (j = 0; j < len; j++) {
          pos = O[num_custom].do_encode(dst, pos, src[src_pos], j);
        }
        num_custom++;
        break;
      case PT_LIST2D: 
        {
          const val = src[src_pos];
          const Y = val.length;
          const X = Y > 0 ? val[0].length : 0;
          const custom = O[num_custom];

          dst.setUint16(pos, X);
          pos += 2;

          dst.setUint16(pos, Y);
          pos += 2;

          for (let i = 0; i < Y; i++)
          {
            const tmp = val[i];

            for (let j = 0; j < X; j++)
            {
              pos = custom.do_encode(dst, pos, tmp, j);
            }
          }

          num_custom++;
          break;
        }
      case PT_CUSTOM: 
        if (!(src[src_pos] instanceof C[num_custom]))
              throw("Type mismatch.");
        pos = O[num_custom].do_encode(dst, pos, src[src_pos].values, 0);
        num_custom++;
        break;
      }
    }

    return pos;
  }

  encode(...args)
  {
    var src = Array.prototype.slice.call(args);
    var dst = new ArrayBuffer(this.low_encoded_length(src));
    this.do_encode(new DataView(dst), 0, src, 0);
    return dst;
  }

  low_encode_to(dst, src)
  {
    this.do_encode(dst, 0, src, 0);
  }

  encode_to(dst, ...src)
  {
    this.do_encode(dst, 0, src, 0);
  }

  do_encoded_length(src, src_pos) {
    if (this._length) return this._length;
    var S = this.signature;
    var C = this.custom;
    var O = this.signatures;
    var i, len, num_custom, j, pos = 0;

    for (num_custom = 0, i = 0; i < S.length; i++, src_pos++) {
      switch (S[i]) {
      case BOOLEAN:
        pos += 1;
        break;
      case UINT8:
        pos += 1;
        break;
      case UINT16:
        pos += 2;
        break;
      case UINT32: 
        pos += 4;
        break;
      case UINT64: 
        pos += 8;
        break;
      case INT8: 
        pos += 1;
        break;
      case INT16: 
        pos += 2;
        break;
      case INT32: 
        pos += 4;
        break;
      case INT64: 
        pos += 8;
        break;
      case FLOAT32: 
        pos += 4;
        break;
      case FLOAT64: 
        pos += 8;
        break;
      case BLOB:
        {
          len = src[src_pos].byteLength;
          pos += 2;
          pos += len;
        }
        break;
      case BLOB16:
        {
          len = src[src_pos].length;
          pos += 2;
          pos += len*2;
        }
        break;
      case REST:
        pos += src[src_pos].length;
        break;
      case PT_BLOBFIXED:
        {
          len = C[num_custom];
          pos += len;
        }
        num_custom++;
        break;
      case STRING:
        pos += 2 + utf8_encoded_length(src[src_pos]);
        break;
      case BITSTRING: 
        pos += 2 + ((src[src_pos].length + 7) >> 3);
        break;
      case PT_BITSTRINGFIXED: 
        pos += (C[num_custom++] + 7)>>3;
        break;
      case PT_MAP: 
        pos += 2;
        if (O[num_custom]._length) {
          pos += O[num_custom]._length * src[src_pos].size;
        } else {
          for (j of src[src_pos])
                pos += O[num_custom].low_encoded_length(j, 0);
        }
        num_custom++;
        break;
      case PT_LIST:
        len = src[src_pos].length;
        pos += 2;
        if (O[num_custom]._length) {
          pos += len * O[num_custom]._length;
        } else {
          for (j = 0; j < len; j++) {
            pos += O[num_custom].encoded_length(src[src_pos][j]);
          }
        }
        num_custom++;
        break;
      case PT_LIST2D: 
        {
          const val = src[src_pos];
          const Y = val.length;
          const X = Y > 0 ? val[0].length : 0;
          const custom = O[num_custom];
          const length = custom._length;

          pos += 4;

          if (length) {
            pos += X*Y*length;
          } else {
            for (let i = 0; i < Y; i++)
            {
              const tmp = val[i];

              for (let j = 0; j < X; j++)
              {
                pos += custom.encoded_length(tmp[j]);
              }
            }
          }
          num_custom++;
        }
        break;
      case PT_LISTFIXED: 
        throw new Error("Unsupported");
      case PT_CUSTOM: 
        if (!(src[src_pos] instanceof C[num_custom])) {
          throw new Error("Bad argument. Expected " + C[num_custom].TypeName + " but got " + src[src_pos]);
        }
        pos += O[num_custom].low_encoded_length(src[src_pos].values, 0);
        num_custom++;
        break;
      }
    }

    return pos;
  }

  low_encoded_length(src)
  {
    if (this._length) return this._length;

    return this.do_encoded_length(src, 0);
  }
 
  encoded_length(...args)
  {
    return this.low_encoded_length(args);
  }
}

export function LIST(type) {
  return [ PT_LIST, type ];
}
export function LIST2D(type) {
  return [ PT_LIST2D, type ];
}
export function LISTFIXED(length, type) {
  return [ PT_LISTFIXED, length, type ];
}
export function MAP(key, value) {
  return [ PT_MAP, key, value ];
}
export function BLOBFIXED(length) {
  return [ PT_BLOBFIXED, length ];
}
export function BITSTRINGFIXED(length) {
  return [ PT_BITSTRINGFIXED, length ];
}
