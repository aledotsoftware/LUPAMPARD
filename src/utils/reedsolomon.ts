// Galois Field 256 arithmetic and Reed-Solomon (RS) systematic encoder/decoder.

const GF256_POLY = 285; // x^8 + x^4 + x^3 + x^2 + 1 (standard AES/RS polynomial)
const gf_exp = new Uint8Array(512);
const gf_log = new Uint8Array(256);

// Initialize tables for fast multiplication and division
let x = 1;
for (let i = 0; i < 255; i++) {
  gf_exp[i] = x;
  gf_log[x] = i;
  x <<= 1;
  if (x & 0x100) {
    x ^= GF256_POLY;
  }
}
for (let i = 255; i < 512; i++) {
  gf_exp[i] = gf_exp[i - 255];
}

export function gf_add(a: number, b: number): number {
  return a ^ b;
}

export function gf_mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return gf_exp[gf_log[a] + gf_log[b]];
}

export function gf_div(a: number, b: number): number {
  if (b === 0) throw new Error("Division by zero in GF(256)");
  if (a === 0) return 0;
  return gf_exp[gf_log[a] - gf_log[b] + 255];
}

// Evaluate polynomial where index 0 is the highest power coefficient: P(x) = sum_i poly[i] x^(N-1-i)
export function eval_codeword(c: Uint8Array, x: number): number {
  let y = 0;
  for (let i = 0; i < c.length; i++) {
    y = gf_mul(y, x) ^ c[i];
  }
  return y;
}

// Evaluate polynomial where index 0 is the constant term coefficient: P(x) = sum_i poly[i] x^i
export function eval_poly_const_first(poly: Uint8Array, x: number): number {
  let y = 0;
  for (let i = poly.length - 1; i >= 0; i--) {
    y = gf_mul(y, x) ^ poly[i];
  }
  return y;
}

// Generate the RS generator polynomial of degree nsym: g(x) = (x - alpha^0)(x - alpha^1)...(x - alpha^(nsym-1))
// Polynomial is returned in constant-first order: [g_0, g_1, ..., g_nsym]
export function rs_generator_poly(nsym: number): Uint8Array {
  let g = new Uint8Array([1]);
  for (let i = 0; i < nsym; i++) {
    const alpha = gf_exp[i];
    const next_g = new Uint8Array(g.length + 1);
    for (let j = 0; j < g.length; j++) {
      next_g[j + 1] ^= g[j];
      next_g[j] ^= gf_mul(g[j], alpha);
    }
    g = next_g;
  }
  return g;
}

/**
 * Systematic Reed-Solomon encoder.
 * Appends nsym parity bytes to the end of the msg.
 */
export function rs_encode(msg: Uint8Array, nsym: number): Uint8Array {
  const gen = rs_generator_poly(nsym);
  const out = new Uint8Array(msg.length + nsym);
  out.set(msg);
  
  for (let i = 0; i < msg.length; i++) {
    const coef = out[i];
    if (coef !== 0) {
      for (let j = 0; j < nsym; j++) {
        out[i + nsym - j] ^= gf_mul(gen[j], coef);
      }
    }
  }
  
  const parity = out.slice(msg.length);
  const encoded = new Uint8Array(msg.length + nsym);
  encoded.set(msg);
  encoded.set(parity, msg.length);
  return encoded;
}

export interface RSDecodeResult {
  data: Uint8Array;
  corrected: boolean;
  errors: number;
}

/**
 * Systematic Reed-Solomon decoder.
 * Corrects up to nsym/2 errors in the codeword msg_out.
 * Returns null if errors are uncorrectable.
 */
export function rs_decode(msg_out: Uint8Array, nsym: number): RSDecodeResult | null {
  const syndromes = new Uint8Array(nsym);
  let has_errors = false;
  for (let i = 0; i < nsym; i++) {
    const val = eval_codeword(msg_out, gf_exp[i]);
    syndromes[i] = val;
    if (val !== 0) {
      has_errors = true;
    }
  }
  
  // No errors detected, return the data part
  if (!has_errors) {
    return { data: msg_out.slice(0, msg_out.length - nsym), corrected: false, errors: 0 };
  }
  
  // Berlekamp-Massey algorithm to find the error locator polynomial Lambda(x)
  let Lambda = new Uint8Array([1]);
  let B = new Uint8Array([1]);
  let L = 0;
  let b = 1;
  
  for (let r = 0; r < nsym; r++) {
    let d = syndromes[r];
    for (let i = 1; i <= L; i++) {
      d ^= gf_mul(Lambda[i] || 0, syndromes[r - i]);
    }
    
    if (d === 0) {
      const next_B = new Uint8Array(B.length + 1);
      next_B.set(B, 1);
      B = next_B;
    } else {
      const Lambda_old = Lambda;
      
      const shifted_B = new Uint8Array(B.length + 1);
      shifted_B.set(B, 1);
      
      const scale = gf_div(d, b);
      const scaled_B = new Uint8Array(shifted_B.length);
      for (let i = 0; i < shifted_B.length; i++) {
        scaled_B[i] = gf_mul(shifted_B[i], scale);
      }
      
      const max_len = Math.max(Lambda.length, scaled_B.length);
      const next_Lambda = new Uint8Array(max_len);
      for (let i = 0; i < max_len; i++) {
        next_Lambda[i] = gf_add(Lambda[i] || 0, scaled_B[i] || 0);
      }
      Lambda = next_Lambda;
      
      if (2 * L <= r) {
        L = r + 1 - L;
        B = Lambda_old;
        b = d;
      } else {
        B = shifted_B;
      }
    }
  }
  
  // Chien search to find the roots of Lambda(x)
  const n = msg_out.length;
  const error_locs: number[] = [];
  for (let idx = 0; idx < n; idx++) {
    const loc = n - 1 - idx;
    const val = eval_poly_const_first(Lambda, gf_exp[255 - loc]);
    if (val === 0) {
      error_locs.push(idx);
    }
  }
  
  // Find degree of Lambda (ignoring leading/trailing zero terms)
  let deg_Lambda = 0;
  for (let i = Lambda.length - 1; i >= 0; i--) {
    if (Lambda[i] !== 0) {
      deg_Lambda = i;
      break;
    }
  }
  
  // If the number of roots found doesn't match the degree of Lambda,
  // we have exceeded the error correction capacity.
  if (error_locs.length !== deg_Lambda) {
    return null;
  }
  
  // Forney algorithm to calculate error values
  const Syndrome_poly = syndromes;
  const Omega = new Uint8Array(nsym);
  for (let i = 0; i < nsym; i++) {
    let sum = 0;
    for (let j = 0; j <= i; j++) {
      sum ^= gf_mul(Syndrome_poly[j], Lambda[i - j] || 0);
    }
    Omega[i] = sum;
  }
  
  // Lambda'(x) derivative
  const Lambda_prime = new Uint8Array(Lambda.length - 1);
  for (let i = 1; i < Lambda.length; i++) {
    if (i % 2 === 1) {
      Lambda_prime[i - 1] = Lambda[i];
    }
  }
  
  const corrected_msg = new Uint8Array(msg_out);
  for (let i = 0; i < error_locs.length; i++) {
    const idx = error_locs[i];
    const loc = n - 1 - idx;
    const Xi = gf_exp[loc];
    const Xi_inv = gf_exp[255 - loc];
    
    const omega_val = eval_poly_const_first(Omega, Xi_inv);
    const lambda_prime_val = eval_poly_const_first(Lambda_prime, Xi_inv);
    
    if (lambda_prime_val === 0) {
      return null;
    }
    
    const err_val = gf_div(gf_mul(Xi, omega_val), lambda_prime_val);
    corrected_msg[idx] ^= err_val;
  }
  
  // Final verification: check if syndromes of corrected message are indeed all zero
  for (let i = 0; i < nsym; i++) {
    if (eval_codeword(corrected_msg, gf_exp[i]) !== 0) {
      return null; // Correction failed or syndromes did not clear
    }
  }
  
  return {
    data: corrected_msg.slice(0, n - nsym),
    corrected: true,
    errors: error_locs.length
  };
}
