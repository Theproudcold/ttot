import { describe, expect, it } from 'vitest';

import {
  SPECTRAL_BAND_ROLE_ORDER,
  buildBandHints,
  computeInterleavedBandMeans,
  identifySpectralBands,
  resolveUsableIndices,
  roleFromBandName,
} from '@/shared/geo/bandIdentification';

describe('roleFromBandName', () => {
  it('matches common vendor band names case-insensitively', () => {
    expect(roleFromBandName('Blue')).toBe('blue');
    expect(roleFromBandName('Green')).toBe('green');
    expect(roleFromBandName('Red')).toBe('red');
    expect(roleFromBandName('NIR')).toBe('nir');
    expect(roleFromBandName('Nir')).toBe('nir');
    expect(roleFromBandName('red edge')).toBe('redEdge');
  });

  it('prefers redEdge over red so "RedEdge" is not mistaken for red', () => {
    expect(roleFromBandName('RedEdge')).toBe('redEdge');
    expect(roleFromBandName('redge')).toBe('redEdge');
    expect(roleFromBandName('RE')).toBe('redEdge');
    expect(roleFromBandName('B2-Red')).toBe('red');
  });

  it('returns null for unrelated descriptions', () => {
    expect(roleFromBandName('Band 1')).toBeNull();
    expect(roleFromBandName('elevation')).toBeNull();
  });
});

describe('buildBandHints', () => {
  it('reads wavelength and name fields from GDAL metadata regardless of key case', () => {
    const hints = buildBandHints({
      sampleCount: 2,
      metadataByBand: [
        { WAVELENGTH: '665', BandName: 'Red' },
        { wavelength: 840, DESCRIPTION: 'Nir' },
      ],
      bandMeans: [0.12, 0.45],
    });

    expect(hints).toEqual([
      { index: 0, wavelength: 665, name: 'Red', mean: 0.12 },
      { index: 1, wavelength: 840, name: 'Nir', mean: 0.45 },
    ]);
  });

  it('tolerates missing metadata and unusable values', () => {
    const hints = buildBandHints({
      sampleCount: 2,
      metadataByBand: [null, { WAVELENGTH: 'abc', BANDNAME: '   ' }],
      bandMeans: [Number.NaN, undefined],
    });

    expect(hints).toEqual([
      { index: 0, wavelength: null, name: null, mean: null },
      { index: 1, wavelength: null, name: null, mean: null },
    ]);
  });
});

describe('computeInterleavedBandMeans', () => {
  it('averages each band of interleaved samples', () => {
    expect(computeInterleavedBandMeans([1, 10, 3, 20, 5, 30], 2)).toEqual([3, 20]);
  });

  it('skips non-finite samples and reports null for empty bands', () => {
    // NaN 属于 0 号波段，因此 1 号波段的均值是 (10 + 20) / 2
    expect(computeInterleavedBandMeans([1, 10, Number.NaN, 20], 2)).toEqual([1, 15]);
    expect(computeInterleavedBandMeans([], 2)).toEqual([null, null]);
    expect(computeInterleavedBandMeans([1, 2], 0)).toEqual([]);
  });
});

describe('identifySpectralBands — wavelength metadata', () => {
  it('assigns roles from wavelengths and needs no confirmation', () => {
    const result = identifySpectralBands({
      sampleCount: 5,
      hints: [475, 560, 660, 720, 840].map((wavelength, index) => ({ index, wavelength })),
    });

    expect(result.method).toBe('wavelength');
    expect(result.confidence).toBe('high');
    expect(result.requiresConfirmation).toBe(false);
    expect(result.assignment).toEqual({ blue: 0, green: 1, red: 2, redEdge: 3, nir: 4 });
    expect(result.missingRoles).toEqual([]);
  });

  it('picks the nearest role centre and refuses far-off wavelengths', () => {
    // 700nm 距红边中心 20nm、距红中心 40nm → 判为红边
    expect(
      identifySpectralBands({ sampleCount: 1, hints: [{ index: 0, wavelength: 700 }] }).assignment,
    ).toEqual({ redEdge: 0 });

    const farOff = identifySpectralBands({
      sampleCount: 1,
      hints: [{ index: 0, wavelength: 2500 }],
    });
    expect(farOff.method).toBe('none');
    expect(farOff.assignment).toEqual({});
  });
});

describe('identifySpectralBands — band names', () => {
  it('assigns roles from names and needs no confirmation', () => {
    const result = identifySpectralBands({
      sampleCount: 5,
      hints: ['Blue', 'Green', 'Red', 'RedEdge', 'NIR'].map((name, index) => ({ index, name })),
    });

    expect(result.method).toBe('band-name');
    expect(result.confidence).toBe('medium');
    expect(result.requiresConfirmation).toBe(false);
    expect(result.assignment).toEqual({ blue: 0, green: 1, red: 2, redEdge: 3, nir: 4 });
  });

  it('prefers wavelength metadata when both are present', () => {
    const result = identifySpectralBands({
      sampleCount: 2,
      hints: [
        { index: 0, wavelength: 660, name: 'unrelated' },
        { index: 1, wavelength: 840, name: 'unrelated' },
      ],
    });

    expect(result.method).toBe('wavelength');
    expect(result.assignment).toEqual({ red: 0, nir: 1 });
  });
});

describe('identifySpectralBands — conventions and heuristics', () => {
  it('falls back to the ODM 5-band order and asks for confirmation', () => {
    const result = identifySpectralBands({ sampleCount: 5 });

    expect(result.method).toBe('convention');
    expect(result.confidence).toBe('medium');
    expect(result.requiresConfirmation).toBe(true);
    expect(result.assignment).toEqual({ blue: 0, green: 1, red: 2, redEdge: 3, nir: 4 });
    expect(result.reasons.join()).toContain('ODM');
  });

  it('treats the 3-band RGB guess as low confidence', () => {
    const result = identifySpectralBands({ sampleCount: 3 });

    expect(result.method).toBe('convention');
    expect(result.confidence).toBe('low');
    expect(result.requiresConfirmation).toBe(true);
    expect(result.assignment).toEqual({ red: 0, green: 1, blue: 2 });
  });

  it('uses band means as a last resort and only proposes nir + red', () => {
    const result = identifySpectralBands({
      sampleCount: 4,
      hints: [
        { index: 0, mean: 0.05 },
        { index: 1, mean: 0.12 },
        { index: 2, mean: 0.03 },
        { index: 3, mean: 0.45 },
      ],
    });

    expect(result.method).toBe('reflectance-heuristic');
    expect(result.confidence).toBe('low');
    expect(result.requiresConfirmation).toBe(true);
    expect(result.assignment).toEqual({ nir: 3, red: 2 });
    expect(result.missingRoles).toEqual(['blue', 'green', 'redEdge']);
    expect(result.reasons.join()).toContain('均值');
  });

  it('refuses to guess when band means are too close', () => {
    const result = identifySpectralBands({
      sampleCount: 2,
      hints: [
        { index: 0, mean: 0.1 },
        { index: 1, mean: 0.1 },
      ],
    });

    expect(result.method).toBe('none');
    expect(result.assignment).toEqual({});
    expect(result.requiresConfirmation).toBe(true);
    expect(result.reasons.join()).toContain('过于接近');
  });

  it('reports the missing roles when only part of the metadata is usable', () => {
    const result = identifySpectralBands({
      sampleCount: 2,
      hints: [
        { index: 0, name: 'Red' },
        { index: 1, name: 'Nir' },
      ],
    });

    expect(result.missingRoles).toEqual(SPECTRAL_BAND_ROLE_ORDER.filter((role) => role !== 'red' && role !== 'nir'));
  });
});

describe('resolveUsableIndices', () => {
  it('lists the indices whose bands are all available', () => {
    expect(resolveUsableIndices({ blue: 0, green: 1, red: 2, redEdge: 3, nir: 4 })).toHaveLength(6);
    expect(resolveUsableIndices({ nir: 3, red: 2 })).toEqual(['ndvi', 'savi']);
    expect(resolveUsableIndices({ nir: 3, red: 2, blue: 0 })).toEqual(['ndvi', 'savi', 'evi']);
    expect(resolveUsableIndices({})).toEqual([]);
  });
});
