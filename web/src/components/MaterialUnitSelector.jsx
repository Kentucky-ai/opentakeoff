import React, { useSyncExternalStore } from 'react';
import { getMaterialUnit, setMaterialUnit, subscribeMaterialUnit } from '../lib/materialUnits.js';
import { localizeText as t } from '../lib/i18n/core.js';
export const useMaterialUnit = () => useSyncExternalStore(subscribeMaterialUnit, getMaterialUnit, () => 'gal');
export default function MaterialUnitSelector({ value, onChange }) {
  const current = useMaterialUnit();
  return <label style={{display:'inline-flex',flexWrap:'wrap',alignItems:'center',gap:8,fontSize:12}} title={t('Liquid volumes and unit prices are converted; purchase rounding follows the original package size.')}>
    {t('Liquid materials')}
    <select aria-label={t('Liquid material units')} className="field-input" style={{width:'auto',padding:'5px 8px'}} value={value ?? current} onChange={e => (onChange || setMaterialUnit)(e.target.value)}>
      <option value="l">{t('Litres (L)')}</option><option value="gal">{t('US gallons')}</option>
    </select>
  </label>;
}
