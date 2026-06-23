import { Box, Typography, Button } from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import { useState } from 'react'
import { NFCReader } from '@/components/nfc/NFCReader'
import { DataEntryForm } from '@/components/forms/DataEntryForm'
import { useAppStore } from '@/store'
import { t } from '@/i18n'

type Step = 'scan' | 'form'

export function ScanPage() {
  const [step, setStep] = useState<Step>('scan')
  const [confirmedTagId, setConfirmedTagId] = useState<string | null>(null)
  const setLastScannedTag = useAppStore(s => s.setLastScannedTag)
  const setCurrentAsset = useAppStore(s => s.setCurrentAsset)

  const handleTagConfirmed = (tagId: string) => {
    setConfirmedTagId(tagId)
    setStep('form')
  }

  const handleFormSuccess = () => {
    // Reset to scan step for the next record
    setConfirmedTagId(null)
    setLastScannedTag(null)
    setCurrentAsset(null)
    setStep('scan')
  }

  const handleBack = () => {
    setStep('scan')
  }

  return (
    <Box sx={{ maxWidth: 640, mx: 'auto' }}>
      {step === 'form' && (
        <Button
          startIcon={<ArrowBackIcon sx={{ transform: 'scaleX(-1)' }} />}
          onClick={handleBack}
          sx={{ mb: 2 }}
        >
          {t.common.back}
        </Button>
      )}

      <Typography variant="h5" fontWeight={700} gutterBottom>
        {step === 'scan' ? t.nfc.title : 'ورود اطلاعات'}
      </Typography>

      {step === 'scan' ? (
        <NFCReader onTagConfirmed={handleTagConfirmed} />
      ) : confirmedTagId ? (
        <DataEntryForm
          nfcTagId={confirmedTagId}
          onSuccess={handleFormSuccess}
          onCancel={handleBack}
        />
      ) : null}
    </Box>
  )
}
