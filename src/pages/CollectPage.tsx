import { Box, Typography, Button, Alert, CircularProgress } from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import { useState, useCallback } from 'react'
import { NFCReader } from '@/components/nfc/NFCReader'
import { DataEntryForm } from '@/components/forms/DataEntryForm'
import { lookupTag } from '@/hooks/useAssets'
import { useSettings } from '@/hooks/useSettings'
import { t } from '@/i18n'
import type { AssetEntry, AssetType } from '@/types'

type Step = 'tag' | 'form'

interface FoundAsset {
  entry: AssetEntry
  assetType: AssetType
  tagId: string
}

export function CollectPage() {
  const { settings } = useSettings()
  const [step, setStep] = useState<Step>('tag')
  const [found, setFound] = useState<FoundAsset | null>(null)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [isLooking, setIsLooking] = useState(false)

  const handleTagConfirmed = useCallback(async (tagId: string) => {
    setIsLooking(true)
    setLookupError(null)
    try {
      const result = await lookupTag(tagId)
      if (!result) {
        setLookupError(t.nfc.tagNotRegistered)
        return
      }
      setFound({ entry: result.entry, assetType: result.assetType, tagId })
      setStep('form')
    } catch {
      setLookupError(t.nfc.tagLookupError)
    } finally {
      setIsLooking(false)
    }
  }, [])

  const handleFormSuccess = useCallback(() => {
    setFound(null)
    setLookupError(null)
    setStep('tag')
  }, [])

  const handleBack = useCallback(() => {
    setFound(null)
    setLookupError(null)
    setStep('tag')
  }, [])

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
        {t.collect.title}
      </Typography>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {step === 'tag' ? t.collect.stepTag : t.collect.stepForm}
      </Typography>

      {step === 'tag' && (
        <>
          <NFCReader
            onTagConfirmed={tagId => void handleTagConfirmed(tagId)}
            allowManualEntry={settings.allowManualEntry}
          />

          {isLooking && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 2 }}>
              <CircularProgress size={20} />
              <Typography variant="body2">{t.common.loading}</Typography>
            </Box>
          )}

          {lookupError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {lookupError}
            </Alert>
          )}
        </>
      )}

      {step === 'form' && found && (
        <DataEntryForm
          nfcTagId={found.tagId}
          assetEntry={found.entry}
          assetType={found.assetType}
          onSuccess={handleFormSuccess}
          onCancel={handleBack}
        />
      )}
    </Box>
  )
}
